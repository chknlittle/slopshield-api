import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_transcripts (
      video_id TEXT PRIMARY KEY,
      transcript_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analysis_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      is_ai INTEGER CHECK (is_ai IS NULL OR is_ai IN (0, 1)),
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(video_id, engine_version)
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_queue
      ON analysis_results(status, next_retry_at, created_at);
  `);

  db.exec(`
    UPDATE analysis_results
    SET status = 'failed', is_ai = NULL, error_code = 'transcript_required',
        error_message = 'Analysis was queued before browser-supplied transcripts were required.',
        next_retry_at = NULL, started_at = NULL,
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status IN ('queued', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM video_transcripts
        WHERE video_transcripts.video_id = analysis_results.video_id
      );
  `);
  db.exec("PRAGMA user_version = 2");
}
