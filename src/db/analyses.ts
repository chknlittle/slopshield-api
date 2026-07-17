import type { Database } from "bun:sqlite";

export type AnalysisStatus = "queued" | "running" | "completed" | "failed";

export interface AnalysisRow {
  id: number;
  video_id: string;
  canonical_url: string;
  engine_version: string;
  status: AnalysisStatus;
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
    return this.db.query(`SELECT * FROM analysis_results WHERE video_id = ? AND engine_version = ?`)
      .get(videoId, this.engineVersion) as AnalysisRow | null;
  }

  ensureQueued(videoId: string, canonicalUrl: string): { row: AnalysisRow; created: boolean } {
    const now = new Date().toISOString();
    const insert = this.db.query(`
      INSERT OR IGNORE INTO analysis_results
        (video_id, canonical_url, engine_version, status, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(videoId, canonicalUrl, this.engineVersion, now, now);
    const row = this.find(videoId);
    if (row === null) throw new Error("Failed to read analysis row after insert");
    return { row, created: insert.changes === 1 };
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
    return this.db.query(`
      UPDATE analysis_results
      SET status = 'running', attempt_count = attempt_count + 1, started_at = ?, updated_at = ?,
          error_code = NULL, error_message = NULL
      WHERE id = (
        SELECT id FROM analysis_results
        WHERE status = 'queued' AND engine_version = ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY created_at, id LIMIT 1
      )
      RETURNING *
    `).get(now, now, this.engineVersion, now) as AnalysisRow | null;
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
      SET status = 'completed', is_ai = ?, result_json = ?, error_code = NULL, error_message = NULL,
          next_retry_at = NULL, completed_at = ?, updated_at = ?
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
      SET status = 'failed', is_ai = NULL, error_code = ?, error_message = ?,
          next_retry_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(code, message, now, now, id);
  }

  counts(): QueueCounts {
    const counts: QueueCounts = { queued: 0, running: 0, completed: 0, failed: 0 };
    const rows = this.db.query(`
      SELECT status, COUNT(*) AS count FROM analysis_results
      WHERE engine_version = ? GROUP BY status
    `).all(this.engineVersion) as Array<{ status: AnalysisStatus; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }
}
