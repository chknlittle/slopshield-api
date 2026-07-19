import type { Database } from "bun:sqlite";

export type PersistedAnalysisStatus = "queued" | "running" | "completed" | "failed";
export type AnalysisStatus = "missing" | PersistedAnalysisStatus;

export interface AnalysisRow {
  id: number;
  video_id: string;
  canonical_url: string;
  engine_version: string;
  transcript_text: string | null;
  status: PersistedAnalysisStatus;
  is_ai: 0 | 1 | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ChannelClaimRow {
  primary_video_id: string;
  confirmation_video_id: string | null;
}

export interface QueueCounts {
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

export class AnalysisRepository {
  constructor(
    private readonly db: Database,
    private readonly engineVersion: string,
  ) {}

  find(videoId: string): AnalysisRow | null {
    return this.db.query(`
      SELECT analysis_results.*, video_transcripts.transcript_text
      FROM analysis_results
      LEFT JOIN video_transcripts USING (video_id)
      WHERE analysis_results.video_id = ? AND engine_version = ?
    `).get(videoId, this.engineVersion) as AnalysisRow | null;
  }

  associateChannel(videoId: string, channelId: string): boolean {
    const now = new Date().toISOString();
    const row = this.db.query("SELECT channel_id FROM video_channels WHERE video_id = ?")
      .get(videoId) as { channel_id: string } | null;

    if (row === null) {
      this.db.query(`
        INSERT INTO video_channels (video_id, channel_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(videoId, channelId, now, now);
      return true;
    }
    if (row.channel_id === channelId) return true;
    if (this.find(videoId) !== null) return false;

    const locked = this.db.query(`
      SELECT 1
      FROM channel_claims
      INNER JOIN analysis_results
        ON analysis_results.video_id IN (
          channel_claims.primary_video_id,
          channel_claims.confirmation_video_id
        )
       AND analysis_results.engine_version = channel_claims.engine_version
      WHERE channel_claims.channel_id = ? AND channel_claims.engine_version = ?
        AND analysis_results.status = 'completed'
    `).get(row.channel_id, this.engineVersion);
    if (locked !== null) return false;

    this.db.query(`
      DELETE FROM channel_claims
      WHERE channel_id = ? AND engine_version = ?
        AND (primary_video_id = ? OR confirmation_video_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM analysis_results
          WHERE analysis_results.video_id IN (
              channel_claims.primary_video_id,
              channel_claims.confirmation_video_id
            )
            AND analysis_results.engine_version = channel_claims.engine_version
            AND analysis_results.status = 'completed'
        )
    `).run(row.channel_id, this.engineVersion, videoId, videoId);
    this.db.query(`
      UPDATE video_channels SET channel_id = ?, updated_at = ? WHERE video_id = ?
    `).run(channelId, now, videoId);
    return true;
  }

  findChannelClaim(channelId: string): ChannelClaimRow | null {
    return this.db.query(`
      SELECT primary_video_id, confirmation_video_id FROM channel_claims
      WHERE channel_id = ? AND engine_version = ?
    `).get(channelId, this.engineVersion) as ChannelClaimRow | null;
  }

  findCompletedChannelEvidence(channelId: string, excludedVideoId: string | null): string | null {
    const row = this.db.query(`
      SELECT analysis_results.video_id
      FROM video_channels
      INNER JOIN analysis_results USING (video_id)
      WHERE video_channels.channel_id = ?
        AND analysis_results.engine_version = ?
        AND analysis_results.status = 'completed'
        AND (? IS NULL OR analysis_results.video_id <> ?)
      ORDER BY analysis_results.is_ai, analysis_results.completed_at, analysis_results.id
      LIMIT 1
    `).get(channelId, this.engineVersion, excludedVideoId, excludedVideoId) as { video_id: string } | null;
    return row?.video_id ?? null;
  }

  claimChannel(channelId: string, primaryVideoId: string): ChannelClaimRow {
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO channel_claims
        (channel_id, engine_version, primary_video_id, confirmation_video_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT(channel_id, engine_version) DO NOTHING
    `).run(channelId, this.engineVersion, primaryVideoId, now, now);

    const claim = this.findChannelClaim(channelId);
    if (claim === null) throw new Error("Channel claim disappeared after insertion");
    return claim;
  }

  reclaimPrimary(channelId: string, videoId: string, staleBefore: string): boolean {
    const now = new Date().toISOString();
    return this.db.query(`
      UPDATE channel_claims
      SET primary_video_id = ?, confirmation_video_id = NULL, updated_at = ?
      WHERE channel_id = ? AND engine_version = ? AND primary_video_id <> ?
        AND (
          EXISTS (
            SELECT 1 FROM analysis_results
            WHERE analysis_results.video_id = channel_claims.primary_video_id
              AND analysis_results.engine_version = channel_claims.engine_version
              AND analysis_results.status = 'failed'
          )
          OR (
            updated_at <= ? AND NOT EXISTS (
              SELECT 1 FROM analysis_results
              WHERE analysis_results.video_id = channel_claims.primary_video_id
                AND analysis_results.engine_version = channel_claims.engine_version
            )
          )
        )
    `).run(videoId, now, channelId, this.engineVersion, videoId, staleBefore).changes === 1;
  }

  claimConfirmation(channelId: string, videoId: string, staleBefore: string): boolean {
    const now = new Date().toISOString();
    return this.db.query(`
      UPDATE channel_claims
      SET confirmation_video_id = ?, updated_at = ?
      WHERE channel_id = ? AND engine_version = ? AND primary_video_id <> ?
        AND (
          confirmation_video_id IS NULL
          OR EXISTS (
            SELECT 1 FROM analysis_results
            WHERE analysis_results.video_id = channel_claims.confirmation_video_id
              AND analysis_results.engine_version = channel_claims.engine_version
              AND analysis_results.status = 'failed'
          )
          OR (
            updated_at <= ? AND NOT EXISTS (
              SELECT 1 FROM analysis_results
              WHERE analysis_results.video_id = channel_claims.confirmation_video_id
                AND analysis_results.engine_version = channel_claims.engine_version
            )
          )
        )
    `).run(videoId, now, channelId, this.engineVersion, videoId, staleBefore).changes === 1;
  }

  submit(
    videoId: string,
    canonicalUrl: string,
    transcript: string | null,
  ): { queued: boolean } | null {
    const now = new Date().toISOString();
    if (transcript !== null) {
      this.db.query(`
        INSERT INTO video_transcripts (video_id, transcript_text, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id) DO NOTHING
      `).run(videoId, transcript, now, now);
    } else {
      const stored = this.db.query("SELECT 1 FROM video_transcripts WHERE video_id = ?").get(videoId);
      if (stored === null) return null;
    }

    const insert = this.db.query(`
      INSERT OR IGNORE INTO analysis_results
        (video_id, canonical_url, engine_version, status, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(videoId, canonicalUrl, this.engineVersion, now, now);

    let queued = insert.changes === 1;
    if (!queued) {
      const update = this.db.query(`
        UPDATE analysis_results
        SET status = 'queued', is_ai = NULL, result_json = NULL,
            error_code = NULL, error_message = NULL, attempt_count = 0,
            next_retry_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
        WHERE video_id = ? AND engine_version = ? AND status = 'failed'
      `).run(now, videoId, this.engineVersion);
      queued = update.changes === 1;
    }

    return { queued };
  }

  recoverRunning(): number {
    const now = new Date().toISOString();
    return this.db.query(`
      UPDATE analysis_results
      SET status = 'queued', next_retry_at = NULL, started_at = NULL, updated_at = ?,
          error_code = 'analysis_interrupted', error_message = 'Worker stopped before analysis completed.'
      WHERE status = 'running' AND engine_version = ?
    `).run(now, this.engineVersion).changes;
  }

  claimNext(): AnalysisRow | null {
    const now = new Date().toISOString();
    const claimed = this.db.query(`
      UPDATE analysis_results
      SET status = 'running', attempt_count = attempt_count + 1, started_at = ?, updated_at = ?,
          error_code = NULL, error_message = NULL
      WHERE id = (
        SELECT analysis_results.id
        FROM analysis_results
        INNER JOIN video_transcripts USING (video_id)
        WHERE status = 'queued' AND engine_version = ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY analysis_results.created_at, analysis_results.id LIMIT 1
      )
      RETURNING id
    `).get(now, now, this.engineVersion, now) as { id: number } | null;

    if (claimed === null) return null;
    return this.db.query(`
      SELECT analysis_results.*, video_transcripts.transcript_text
      FROM analysis_results
      INNER JOIN video_transcripts USING (video_id)
      WHERE analysis_results.id = ?
    `).get(claimed.id) as AnalysisRow;
  }

  nextRetryAt(): string | null {
    const row = this.db.query(`
      SELECT MIN(next_retry_at) AS next_retry_at
      FROM analysis_results
      WHERE status = 'queued' AND engine_version = ? AND next_retry_at IS NOT NULL
    `).get(this.engineVersion) as { next_retry_at: string | null };
    return row.next_retry_at;
  }

  complete(id: number, isAi: boolean, resultJson: string): void {
    const now = new Date().toISOString();
    this.db.query(`
      UPDATE analysis_results
      SET status = 'completed', is_ai = ?, result_json = ?,
          error_code = NULL, error_message = NULL, next_retry_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(isAi ? 1 : 0, resultJson, now, now, id);
  }

  retry(id: number, code: string, message: string, nextRetryAt: string): void {
    const now = new Date().toISOString();
    this.db.query(`
      UPDATE analysis_results
      SET status = 'queued', is_ai = NULL, error_code = ?, error_message = ?,
          next_retry_at = ?, started_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(code, message, nextRetryAt, now, id);
  }

  fail(id: number, code: string, message: string): void {
    const now = new Date().toISOString();
    this.db.query(`
      UPDATE analysis_results
      SET status = 'failed', is_ai = NULL,
          error_code = ?, error_message = ?, next_retry_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(code, message, now, now, id);
  }

  counts(): QueueCounts {
    const counts: QueueCounts = { queued: 0, running: 0, completed: 0, failed: 0 };
    const rows = this.db.query(`
      SELECT status, COUNT(*) AS count FROM analysis_results
      WHERE engine_version = ? GROUP BY status
    `).all(this.engineVersion) as Array<{ status: PersistedAnalysisStatus; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }
}
