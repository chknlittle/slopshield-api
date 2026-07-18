import type { Config } from "../config";
import { AnalysisRepository, type AnalysisRow, type AnalysisStatus } from "../db/analyses";
import { canonicalYouTubeUrl, parseVideoId } from "../youtube/urls";

const MAX_TRANSCRIPT_CHARACTERS = 2_000_000;

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
  needs_transcript: boolean;
  is_ai: boolean | null;
  result: unknown | null;
  error: ApiError | null;
}

interface NormalizedInput {
  input: unknown;
  videoId: string | null;
  transcript: string | null;
  error: ApiError | null;
}

type BatchRequest =
  | { ok: true; inputs: unknown[] }
  | { ok: false; response: Response };

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
    needs_transcript: false,
    is_ai: row.status === "completed" ? row.is_ai === 1 : null,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    error: row.error_code === null ? null : {
      code: row.error_code,
      message: row.error_message ?? "Analysis failed.",
    },
  };
}

function failedEntry(
  input: unknown,
  videoId: string | null,
  engineVersion: string,
  error: ApiError,
): AnalysisEntry {
  return {
    input_url: input,
    video_id: videoId,
    engine_version: engineVersion,
    status: "failed",
    cached: false,
    needs_transcript: false,
    is_ai: null,
    result: null,
    error,
  };
}

async function readBatchRequest(request: Request): Promise<BatchRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: json({ error: { code: "invalid_request", message: "Request body must be valid JSON." } }, 400) };
  }

  if (typeof body !== "object" || body === null || !("videos" in body) || !Array.isArray(body.videos)) {
    return { ok: false, response: json({ error: { code: "invalid_request", message: "Request body must contain a videos array." } }, 400) };
  }
  if (body.videos.length < 1 || body.videos.length > 100) {
    return { ok: false, response: json({ error: { code: "invalid_batch_size", message: "videos must contain between 1 and 100 entries." } }, 400) };
  }

  return { ok: true, inputs: body.videos };
}

function normalizeInputs(inputs: unknown[]): NormalizedInput[] {
  return inputs.map((item) => {
    if (typeof item !== "object" || item === null || !("url" in item)) {
      return {
        input: item,
        videoId: null,
        transcript: null,
        error: { code: "invalid_video", message: "Each videos entry must be an object containing url." },
      };
    }

    const input = item.url;
    const videoId = typeof input === "string" ? parseVideoId(input) : null;
    if (videoId === null) {
      return {
        input,
        videoId: null,
        transcript: null,
        error: { code: "invalid_youtube_url", message: "url must be a supported YouTube URL or 11-character video ID." },
      };
    }

    if (!("transcript" in item)) return { input, videoId, transcript: null, error: null };
    if (typeof item.transcript !== "string" || item.transcript.trim().length === 0) {
      return {
        input,
        videoId,
        transcript: null,
        error: { code: "invalid_transcript", message: "transcript must be a non-empty string when provided." },
      };
    }
    if (item.transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
      return {
        input,
        videoId,
        transcript: null,
        error: {
          code: "transcript_too_large",
          message: `transcript must not exceed ${MAX_TRANSCRIPT_CHARACTERS} characters.`,
        },
      };
    }

    return { input, videoId, transcript: item.transcript, error: null };
  });
}

function missingEntry(input: unknown, videoId: string, engineVersion: string): AnalysisEntry {
  return {
    input_url: input,
    video_id: videoId,
    engine_version: engineVersion,
    status: "missing",
    cached: false,
    needs_transcript: true,
    is_ai: null,
    result: null,
    error: null,
  };
}

function batchResponse(engineVersion: string, entries: AnalysisEntry[]): Response {
  const statuses = { missing: 0, queued: 0, running: 0, completed: 0, failed: 0 };
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
    const wasCached = this.submitAvailableAnalyses(inputs);
    const entries = this.loadEntries(inputs, wasCached);
    return batchResponse(this.config.engineVersion, entries);
  }

  private submitAvailableAnalyses(inputs: NormalizedInput[]): Map<string, boolean> {
    const wasCached = new Map<string, boolean>();
    const submissions = new Map<string, string | null>();

    for (const input of inputs) {
      if (input.videoId === null || input.error !== null) continue;
      if (!wasCached.has(input.videoId)) {
        const existing = this.analyses.find(input.videoId);
        wasCached.set(input.videoId, existing !== null);
        if (existing === null || input.transcript !== null) {
          submissions.set(input.videoId, input.transcript);
        }
      } else if (input.transcript !== null) {
        submissions.set(input.videoId, input.transcript);
      }
    }

    let queued = false;
    for (const [videoId, transcript] of submissions) {
      const result = this.analyses.submit(
        videoId,
        canonicalYouTubeUrl(videoId),
        transcript,
      );
      queued ||= result?.queued ?? false;
    }
    if (queued) this.wakeWorker();

    return wasCached;
  }

  private loadEntries(inputs: NormalizedInput[], wasCached: Map<string, boolean>): AnalysisEntry[] {
    return inputs.map(({ input, videoId, transcript, error }) => {
      if (error !== null) return failedEntry(input, videoId, this.config.engineVersion, error);
      if (videoId === null) throw new Error("Normalized input has neither video ID nor error");

      const row = this.analyses.find(videoId);
      if (row !== null) {
        if (row.status === "failed" && row.transcript_text === null) {
          return missingEntry(input, videoId, this.config.engineVersion);
        }
        return entryFromRow(input, row, wasCached.get(videoId) ?? true);
      }
      if (transcript === null) {
        return missingEntry(input, videoId, this.config.engineVersion);
      }
      throw new Error("Submitted analysis disappeared after insertion");
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
