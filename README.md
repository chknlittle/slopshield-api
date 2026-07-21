# SlopShield API

A small Bun/TypeScript API that puts a persistent cache and queue in front of the SlopShield Engine v1. The browser extension supplies YouTube transcripts; requests return immediately while uncached analyses run in the background.

## Built with OpenAI Codex and GPT-5.6

We used OpenAI Codex with GPT-5.6 to design and review this API.

Codex helped build the persistent analysis queue and cache.

It helped separate reusable transcripts from versioned results.

It helped design video evidence and channel-level verdicts.

It helped require independent confirmation before an AI channel verdict.

It helped keep failed analyses separate from benign results.

It also helped reason about retries, workers, shutdown, and engine boundaries.

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

Direct engine results remain keyed by `(video_id, engine_version)`. Channel evidence claims are keyed by `(channel_id, engine_version)`, so changing the configured engine version creates a fresh video and channel cache namespace without deleting old results.

## API

### Queue/read analyses

```bash
curl -sS http://localhost:3000/v1/analyses \
  -H 'content-type: application/json' \
  -d '{"videos":[
    {
      "url":"https://youtube.com/watch?v=_xnni6MrTHM",
      "channel_id":"UCxxxxxxxxxxxxxxxxxxxxxx",
      "evidence_candidate":true,
      "transcript":"[0.00 -> 3.20] Browser-fetched caption text"
    }
  ]}' | jq
```

`POST /v1/analyses` accepts 1–100 `{url, channel_id?, evidence_candidate?, transcript?}` objects and returns HTTP 202 immediately. It preserves input order and emits one response entry per input. `channel_id`, when supplied, must be YouTube's immutable 24-character `UC…` ID. Alternate URLs for the same video share one database row and one unit of work.

For an uncached video without channel metadata—or for the selected evidence video of a new channel—`transcript` is required and must contain the timestamped caption text fetched by the browser. Poll an existing submission by sending the same `url` without a transcript. An evidence cache miss without a stored transcript returns `status: "missing"` and `needs_transcript: true` without enqueueing work; channel siblings wait without requesting transcripts. If a transcript is already stored for the evidence video, the API queues the active engine version itself.

Transcripts are persisted once per video in `video_transcripts`, independently of engine-version results. Later public submissions do not overwrite the stored transcript. This allows a new engine version to re-score stored videos without asking the browser to fetch their captions again.

When channel IDs are supplied, the first `evidence_candidate: true` video encountered becomes the channel's primary evidence for the active engine version. A benign primary result verifies the channel immediately. An AI-positive primary result remains a direct video verdict until a different candidate video is independently analyzed: two positive results classify the channel as AI, while a benign confirmation classifies it as benign. The extension marks only viewport videos as candidates. Inferred results are never stored as direct evidence.

A completed entry resembles:

```json
{
  "input_url": "https://youtube.com/watch?v=_xnni6MrTHM",
  "video_id": "_xnni6MrTHM",
  "channel_id": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "engine_version": "v1",
  "status": "completed",
  "cached": true,
  "is_ai": true,
  "classification_source": "video",
  "evidence_video_id": "_xnni6MrTHM",
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

`is_ai` is `true` only for engine verdict `ai_suspect`, `false` only for `most likely not AI`, and `null` for queued/running/failed work. Engine and transcript failures are never interpreted as not-AI. `classification_source` is `video` for direct evidence and `channel` for an inherited verdict; `evidence_video_id` identifies the direct result returned for that entry. `cached` indicates whether the relevant result existed before that POST.

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

SQLite's `analysis_results` table is both direct-result cache and persistent queue. `video_transcripts` stores reusable browser-supplied transcripts separately. `video_channels` records immutable video/channel associations, while `channel_claims` tracks primary and optional confirmation evidence per `(channel_id, engine_version)`. Workers atomically claim analysis rows and join them to the corresponding transcript. New inserts wake the in-process workers immediately; idle workers block without polling SQLite, and scheduled retries use a timer for their exact `next_retry_at` deadline. Interrupted `running` rows return to `queued` on startup. Transient failures receive up to three total attempts with exponential backoff; terminal failures preserve a stable error code and always have `is_ai: null`. SIGINT/SIGTERM stops HTTP intake, aborts/awaits workers, and closes SQLite.
