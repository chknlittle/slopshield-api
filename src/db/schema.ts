import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  db.exec(`
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
  db.exec("PRAGMA user_version = 1");
}
