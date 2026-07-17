# SlopShield API

A small Bun/TypeScript API that puts a persistent read-through cache and queue in front of the SlopShield Engine v1. Requests never wait for uncached YouTube analyses: missing videos are queued in SQLite and processed in the background.

## Run

Requires [Bun](https://bun.sh/).

```bash
bun install
cp .env.example .env  # optional; Bun loads it automatically
bun run start
```

Development and static checking:

```bash
bun run dev
bun run typecheck
```

The default API address is `http://localhost:3000`. Runtime state is stored in `./data/slopshield.sqlite3` (with SQLite WAL sidecar files). Resolve relative paths from the directory where the process is started.

## Configuration

| Variable | Default |
|---|---|
| `SLOPSHIELD_HOST` | `0.0.0.0` |
| `SLOPSHIELD_PORT` | `3000` |
| `SLOPSHIELD_DB_PATH` | `./data/slopshield.sqlite3` |
| `SLOPSHIELD_ENGINE_VERSION` | `v1` |
| `SLOPSHIELD_ENGINE_URL` | `http://192.168.0.129:8765` |
| `SLOPSHIELD_WORKER_CONCURRENCY` | `2` |
| `SLOPSHIELD_ENGINE_TIMEOUT_MS` | `300000` |

The cache key is `(video_id, engine_version)`. Changing the configured engine version creates a fresh cache namespace without deleting old results.

## API

### Queue/read analyses

```bash
curl -sS http://localhost:3000/v1/analyses \
  -H 'content-type: application/json' \
  -d '{"urls":[
    "https://youtube.com/watch?v=_xnni6MrTHM",
    "https://youtu.be/_xnni6MrTHM?t=10",
    "not-a-video"
  ]}' | jq
```

`POST /v1/analyses` accepts 1–100 strings and returns HTTP 202 immediately. It preserves input order and emits one response entry per input. Alternate URLs for the same video share one database row and one unit of work. Repeat the same request to observe `queued` → `running` → `completed` (or `failed`). Invalid entries fail individually with `invalid_youtube_url`.

A completed entry resembles:

```json
{
  "input_url": "https://youtube.com/watch?v=_xnni6MrTHM",
  "video_id": "_xnni6MrTHM",
  "engine_version": "v1",
  "status": "completed",
  "cached": true,
  "is_ai": true,
  "result": {
    "video_id": "_xnni6MrTHM",
    "verdict": "ai_suspect",
    "max_text_score": 0.36,
    "text_scale_scores": { "10": 0.2, "20": 0.3, "40": 0.3, "80": 0.1 },
    "text_pick": { "start": 10, "end": 20, "start_ts": "00:10", "end_ts": "00:20", "score": 0.3, "leaf_score": 0.2, "context_seconds": 40, "text": "..." },
    "spoof": 0.96,
    "saved_audio": null
  },
  "error": null
}
```

`is_ai` is `true` only for engine verdict `ai_suspect`, `false` only for `most likely not AI`, and `null` for queued/running/failed work. Engine and transcript failures are never interpreted as not-AI. `cached` indicates whether the cache row existed before that POST.

### Read one cached analysis

```bash
curl -sS http://localhost:3000/v1/analyses/_xnni6MrTHM | jq
```

`GET /v1/analyses/:videoId` is read-only and returns 404 rather than enqueueing a missing video.

### Health

```bash
curl -sS http://localhost:3000/health | jq
```

Health includes API status, configured engine URL/version and current reachability, worker state, and queue counts for the configured engine version.

## Queue behavior

SQLite's `analysis_results` table is both cache and persistent queue. Workers atomically claim rows. New inserts wake the in-process workers immediately; idle workers block without polling SQLite, and scheduled retries use a timer for their exact `next_retry_at` deadline. Interrupted `running` rows return to `queued` on startup. Transient failures receive up to three total attempts with exponential backoff; terminal failures preserve a stable error code and always have `is_ai: null`. SIGINT/SIGTERM stops HTTP intake, aborts/awaits workers, and closes SQLite.
