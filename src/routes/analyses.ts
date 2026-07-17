import type { Config } from "../config";
import { AnalysisRepository, type AnalysisRow, type AnalysisStatus } from "../db/analyses";
import { canonicalYouTubeUrl, parseVideoId } from "../youtube/urls";

interface ApiError {
  code: string;
  message: string;
}

interface AnalysisEntry {
  input_url: unknown;
  video_id: string | null;
  engine_version: string;
  status: AnalysisStatus;
  cached: boolean;
  is_ai: boolean | null;
  result: unknown | null;
  error: ApiError | null;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function entryFromRow(input: unknown, row: AnalysisRow, cached: boolean): AnalysisEntry {
  return {
    input_url: input,
    video_id: row.video_id,
    engine_version: row.engine_version,
    status: row.status,
    cached,
    is_ai: row.status === "completed" ? row.is_ai === 1 : null,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    error: row.error_code === null ? null : {
      code: row.error_code,
      message: row.error_message ?? "Analysis failed.",
    },
  };
}

function invalidEntry(input: unknown, engineVersion: string): AnalysisEntry {
  return {
    input_url: input,
    video_id: null,
    engine_version: engineVersion,
    status: "failed",
    cached: false,
    is_ai: null,
    result: null,
    error: {
      code: "invalid_youtube_url",
      message: "Input is not a supported YouTube URL or 11-character video ID.",
    },
  };
}

interface NormalizedInput {
  input: unknown;
  videoId: string | null;
}

type BatchRequest =
  | { ok: true; inputs: unknown[] }
  | { ok: false; response: Response };

async function readBatchRequest(request: Request): Promise<BatchRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: json({ error: { code: "invalid_request", message: "Request body must be valid JSON." } }, 400) };
  }

  if (typeof body !== "object" || body === null || !("urls" in body) || !Array.isArray(body.urls)) {
    return { ok: false, response: json({ error: { code: "invalid_request", message: "Request body must contain a urls array." } }, 400) };
  }
  if (body.urls.length < 1 || body.urls.length > 100) {
    return { ok: false, response: json({ error: { code: "invalid_batch_size", message: "urls must contain between 1 and 100 entries." } }, 400) };
  }

  return { ok: true, inputs: body.urls };
}

function normalizeInputs(inputs: unknown[]): NormalizedInput[] {
  return inputs.map((input) => ({
    input,
    videoId: typeof input === "string" ? parseVideoId(input) : null,
  }));
}

function batchResponse(engineVersion: string, entries: AnalysisEntry[]): Response {
  const statuses = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const entry of entries) statuses[entry.status] += 1;
  const valid = entries.filter((entry) => entry.video_id !== null).length;

  return json({
    engine_version: engineVersion,
    summary: { total: entries.length, valid, invalid: entries.length - valid, ...statuses },
    analyses: entries,
  }, 202);
}

export class AnalysisRoutes {
  constructor(
    private readonly config: Config,
    private readonly analyses: AnalysisRepository,
    private readonly wakeWorker: () => void,
  ) {}

  async post(request: Request): Promise<Response> {
    const batch = await readBatchRequest(request);
    if (!batch.ok) return batch.response;

    const inputs = normalizeInputs(batch.inputs);
    const wasCached = this.ensureAnalysesExist(inputs);
    const entries = this.loadEntries(inputs, wasCached);
    return batchResponse(this.config.engineVersion, entries);
  }

  private ensureAnalysesExist(inputs: NormalizedInput[]): Map<string, boolean> {
    const videoIds = inputs.flatMap(({ videoId }) => videoId === null ? [] : [videoId]);
    const wasCached = new Map<string, boolean>();
    let inserted = false;

    for (const videoId of new Set(videoIds)) {
      const row = this.analyses.ensureQueued(videoId, canonicalYouTubeUrl(videoId));
      wasCached.set(videoId, !row.created);
      inserted ||= row.created;
    }
    if (inserted) this.wakeWorker();

    return wasCached;
  }

  private loadEntries(inputs: NormalizedInput[], wasCached: Map<string, boolean>): AnalysisEntry[] {
    return inputs.map(({ input, videoId }) => {
      if (videoId === null) return invalidEntry(input, this.config.engineVersion);

      const row = this.analyses.find(videoId);
      if (row === null) throw new Error("Analysis disappeared after insertion");
      return entryFromRow(input, row, wasCached.get(videoId) ?? true);
    });
  }

  get(videoIdInput: string): Response {
    const videoId = parseVideoId(videoIdInput);
    if (videoId === null) {
      return json({
        engine_version: this.config.engineVersion,
        error: { code: "invalid_youtube_url", message: "Path parameter must be an 11-character YouTube video ID." },
      }, 400);
    }

    const row = this.analyses.find(videoId);
    if (row === null) {
      return json({
        engine_version: this.config.engineVersion,
        error: { code: "analysis_not_found", message: "No cached analysis exists for this video and engine version." },
      }, 404);
    }

    return json({ engine_version: this.config.engineVersion, analysis: entryFromRow(videoIdInput, row, true) });
  }
}
