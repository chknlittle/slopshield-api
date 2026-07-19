import type { Config } from "../config";
import { AnalysisRepository, type AnalysisRow, type AnalysisStatus } from "../db/analyses";
import { canonicalYouTubeUrl, parseVideoId } from "../youtube/urls";

const MAX_TRANSCRIPT_CHARACTERS = 2_000_000;
const CHANNEL_CLAIM_LEASE_MS = 10 * 60_000;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

type ClassificationSource = "video" | "channel";

interface ApiError {
  code: string;
  message: string;
}

interface AnalysisEntry {
  input_url: unknown;
  video_id: string | null;
  channel_id: string | null;
  engine_version: string;
  status: AnalysisStatus;
  cached: boolean;
  needs_transcript: boolean;
  is_ai: boolean | null;
  classification_source: ClassificationSource | null;
  evidence_video_id: string | null;
  result: unknown | null;
  error: ApiError | null;
}

interface NormalizedInput {
  input: unknown;
  videoId: string | null;
  channelId: string | null;
  evidenceCandidate: boolean;
  transcript: string | null;
  error: ApiError | null;
}

type BatchRequest =
  | { ok: true; inputs: unknown[] }
  | { ok: false; response: Response };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function entryFromRow(
  input: unknown,
  requestedVideoId: string,
  channelId: string | null,
  row: AnalysisRow,
  cached: boolean,
  source: ClassificationSource,
  evidenceVideoId: string,
): AnalysisEntry {
  return {
    input_url: input,
    video_id: requestedVideoId,
    channel_id: channelId,
    engine_version: row.engine_version,
    status: row.status,
    cached,
    needs_transcript: false,
    is_ai: row.status === "completed" ? row.is_ai === 1 : null,
    classification_source: source,
    evidence_video_id: evidenceVideoId,
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
  channelId: string | null,
  engineVersion: string,
  error: ApiError,
): AnalysisEntry {
  return {
    input_url: input,
    video_id: videoId,
    channel_id: channelId,
    engine_version: engineVersion,
    status: "failed",
    cached: false,
    needs_transcript: false,
    is_ai: null,
    classification_source: null,
    evidence_video_id: null,
    result: null,
    error,
  };
}

function missingEntry(
  input: unknown,
  videoId: string,
  channelId: string | null,
  engineVersion: string,
): AnalysisEntry {
  return {
    input_url: input,
    video_id: videoId,
    channel_id: channelId,
    engine_version: engineVersion,
    status: "missing",
    cached: false,
    needs_transcript: true,
    is_ai: null,
    classification_source: "video",
    evidence_video_id: videoId,
    result: null,
    error: null,
  };
}

function unclaimedChannelEntry(
  input: unknown,
  videoId: string,
  channelId: string,
  engineVersion: string,
): AnalysisEntry {
  return {
    input_url: input,
    video_id: videoId,
    channel_id: channelId,
    engine_version: engineVersion,
    status: "queued",
    cached: false,
    needs_transcript: false,
    is_ai: null,
    classification_source: null,
    evidence_video_id: null,
    result: null,
    error: null,
  };
}

function waitingOnChannelEntry(
  input: unknown,
  videoId: string,
  channelId: string,
  engineVersion: string,
  evidenceVideoId: string,
): AnalysisEntry {
  return {
    input_url: input,
    video_id: videoId,
    channel_id: channelId,
    engine_version: engineVersion,
    status: "queued",
    cached: false,
    needs_transcript: false,
    is_ai: null,
    classification_source: "channel",
    evidence_video_id: evidenceVideoId,
    result: null,
    error: null,
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
        channelId: null,
        evidenceCandidate: false,
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
        channelId: null,
        evidenceCandidate: false,
        transcript: null,
        error: { code: "invalid_youtube_url", message: "url must be a supported YouTube URL or 11-character video ID." },
      };
    }

    let channelId: string | null = null;
    if ("channel_id" in item) {
      if (typeof item.channel_id !== "string" || !CHANNEL_ID.test(item.channel_id)) {
        return {
          input,
          videoId,
          channelId: null,
          evidenceCandidate: false,
          transcript: null,
          error: { code: "invalid_channel_id", message: "channel_id must be an immutable 24-character YouTube UC channel ID." },
        };
      }
      channelId = item.channel_id;
    }

    const evidenceCandidate = !("evidence_candidate" in item) || item.evidence_candidate === true;

    if (!("transcript" in item)) return { input, videoId, channelId, evidenceCandidate, transcript: null, error: null };
    if (typeof item.transcript !== "string" || item.transcript.trim().length === 0) {
      return {
        input,
        videoId,
        channelId,
        evidenceCandidate,
        transcript: null,
        error: { code: "invalid_transcript", message: "transcript must be a non-empty string when provided." },
      };
    }
    if (item.transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
      return {
        input,
        videoId,
        channelId,
        evidenceCandidate,
        transcript: null,
        error: {
          code: "transcript_too_large",
          message: `transcript must not exceed ${MAX_TRANSCRIPT_CHARACTERS} characters.`,
        },
      };
    }

    return { input, videoId, channelId, evidenceCandidate, transcript: item.transcript, error: null };
  });
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
    this.registerChannelsAndClaims(inputs);
    const wasCached = this.submitAvailableAnalyses(inputs);
    const entries = this.loadEntries(inputs, wasCached);
    return batchResponse(this.config.engineVersion, entries);
  }

  private registerChannelsAndClaims(inputs: NormalizedInput[]): void {
    const byChannel = new Map<string, NormalizedInput[]>();

    for (const input of inputs) {
      if (input.videoId === null || input.channelId === null || input.error !== null) continue;
      if (!this.analyses.associateChannel(input.videoId, input.channelId)) {
        input.error = {
          code: "channel_mismatch",
          message: "This video is already associated with a different immutable channel ID.",
        };
        continue;
      }
      const group = byChannel.get(input.channelId) ?? [];
      group.push(input);
      byChannel.set(input.channelId, group);
    }

    for (const [channelId, group] of byChannel) {
      const candidateExcluding = (excluded: string | null) =>
        this.analyses.findCompletedChannelEvidence(channelId, excluded) ??
        group.find((input) => input.videoId !== excluded && input.evidenceCandidate)?.videoId ??
        null;

      const claim = this.analyses.findChannelClaim(channelId);
      if (claim === null) {
        const candidate = candidateExcluding(null);
        if (candidate) this.analyses.claimChannel(channelId, candidate);
        continue;
      }

      const staleBefore = new Date(Date.now() - CHANNEL_CLAIM_LEASE_MS).toISOString();
      const primary = this.analyses.find(claim.primary_video_id);
      if (primary?.status === "failed" || primary === null) {
        const candidate = candidateExcluding(claim.primary_video_id);
        if (candidate) {
          this.analyses.reclaimPrimary(channelId, candidate, staleBefore);
        }
        continue;
      }

      if (primary.status === "completed" && primary.is_ai === 1) {
        const confirmation = claim.confirmation_video_id === null
          ? null
          : this.analyses.find(claim.confirmation_video_id);
        if (claim.confirmation_video_id === null || confirmation?.status === "failed" || confirmation === null) {
          const candidate = candidateExcluding(claim.primary_video_id);
          if (candidate) {
            this.analyses.claimConfirmation(channelId, candidate, staleBefore);
          }
        }
      }
    }
  }

  private submitAvailableAnalyses(inputs: NormalizedInput[]): Map<string, boolean> {
    const wasCached = new Map<string, boolean>();
    const submissions = new Map<string, string | null>();

    for (const input of inputs) {
      if (input.videoId === null || input.error !== null) continue;
      if (!wasCached.has(input.videoId)) {
        const existing = this.analyses.find(input.videoId);
        wasCached.set(input.videoId, existing !== null);

        const claim = input.channelId === null ? null : this.analyses.findChannelClaim(input.channelId);
        const maySubmit = input.channelId === null ||
          claim?.primary_video_id === input.videoId ||
          claim?.confirmation_video_id === input.videoId;
        if (maySubmit && (existing === null || input.transcript !== null)) {
          submissions.set(input.videoId, input.transcript);
        }
      } else if (input.transcript !== null) {
        const claim = input.channelId === null ? null : this.analyses.findChannelClaim(input.channelId);
        if (
          input.channelId === null ||
          claim?.primary_video_id === input.videoId ||
          claim?.confirmation_video_id === input.videoId
        ) submissions.set(input.videoId, input.transcript);
      }
    }

    let queued = false;
    for (const [videoId, transcript] of submissions) {
      const result = this.analyses.submit(videoId, canonicalYouTubeUrl(videoId), transcript);
      queued ||= result?.queued ?? false;
    }
    if (queued) this.wakeWorker();

    return wasCached;
  }

  private loadEntries(inputs: NormalizedInput[], wasCached: Map<string, boolean>): AnalysisEntry[] {
    return inputs.map(({ input, videoId, channelId, transcript, error }) => {
      if (error !== null) return failedEntry(input, videoId, channelId, this.config.engineVersion, error);
      if (videoId === null) throw new Error("Normalized input has neither video ID nor error");

      const claim = channelId === null ? null : this.analyses.findChannelClaim(channelId);
      const isEvidence = claim !== null && (
        claim.primary_video_id === videoId || claim.confirmation_video_id === videoId
      );
      if (claim !== null && !isEvidence) {
        const primary = this.analyses.find(claim.primary_video_id);
        if (primary?.status === "completed" && primary.is_ai === 0) {
          return entryFromRow(
            input, videoId, channelId, primary, true, "channel", claim.primary_video_id,
          );
        }
        if (primary?.status === "completed" && primary.is_ai === 1 && claim.confirmation_video_id !== null) {
          const confirmation = this.analyses.find(claim.confirmation_video_id);
          if (confirmation?.status === "completed") {
            return entryFromRow(
              input, videoId, channelId, confirmation, true, "channel", claim.confirmation_video_id,
            );
          }
          if (confirmation?.status === "failed") {
            return entryFromRow(
              input, videoId, channelId, confirmation, true, "channel", claim.confirmation_video_id,
            );
          }
        }
        if (primary?.status === "failed") {
          return entryFromRow(
            input, videoId, channelId, primary, true, "channel", claim.primary_video_id,
          );
        }
        return waitingOnChannelEntry(
          input,
          videoId,
          channelId!,
          this.config.engineVersion,
          claim.confirmation_video_id ?? claim.primary_video_id,
        );
      }

      const direct = this.analyses.find(videoId);
      if (direct !== null) {
        if (direct.status === "failed" && direct.transcript_text === null) {
          return missingEntry(input, videoId, channelId, this.config.engineVersion);
        }
        return entryFromRow(
          input,
          videoId,
          channelId,
          direct,
          wasCached.get(videoId) ?? true,
          "video",
          videoId,
        );
      }

      if (channelId !== null && claim === null) {
        return unclaimedChannelEntry(input, videoId, channelId, this.config.engineVersion);
      }

      if (transcript === null) {
        return missingEntry(input, videoId, channelId, this.config.engineVersion);
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
        error: { code: "analysis_not_found", message: "No cached direct analysis exists for this video and engine version." },
      }, 404);
    }

    return json({
      engine_version: this.config.engineVersion,
      analysis: entryFromRow(videoIdInput, videoId, null, row, true, "video", videoId),
    });
  }
}
