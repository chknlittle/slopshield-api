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
