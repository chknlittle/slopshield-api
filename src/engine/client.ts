import type { Config } from "../config";
import { isEngineAnalysis, type EngineAnalysis } from "./types";

export type EngineErrorCode = "engine_unreachable" | "engine_rejected_request" | "engine_invalid_response" | "analysis_failed";

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

function responseMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // Fall back to a bounded plain-text response.
  }
  const compact = body.trim().slice(0, 300);
  return compact || `Engine returned HTTP ${status}`;
}

async function readAnalysisResponse(response: Response, videoId: string): Promise<EngineAnalysis> {
  const body = await response.text();
  if (!response.ok) {
    const message = responseMessage(body, response.status);
    if (response.status >= 500) throw new EngineError("analysis_failed", message, true);
    throw new EngineError("engine_rejected_request", message, false);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new EngineError("engine_invalid_response", "Engine returned invalid JSON.", false);
  }
  if (!isEngineAnalysis(parsed, videoId)) {
    throw new EngineError("engine_invalid_response", "Engine response did not match the v1 schema.", false);
  }
  return parsed;
}

export class EngineClient {
  constructor(private readonly config: Config) {}

  async analyze(videoId: string, transcript: string, shutdownSignal: AbortSignal): Promise<EngineAnalysis> {
    const response = await this.requestAnalysis(videoId, transcript, shutdownSignal);
    return readAnalysisResponse(response, videoId);
  }

  private async requestAnalysis(videoId: string, transcript: string, shutdownSignal: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.config.engineUrl}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `https://www.youtube.com/watch?v=${videoId}`,
          transcript,
        }),
        signal: AbortSignal.any([shutdownSignal, AbortSignal.timeout(this.config.engineTimeoutMs)]),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network request failed";
      throw new EngineError("engine_unreachable", message, true);
    }
  }

  async reachable(timeoutMs = 2_000): Promise<{ reachable: boolean; status: number | null }> {
    try {
      const response = await fetch(`${this.config.engineUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return { reachable: response.ok, status: response.status };
    } catch {
      return { reachable: false, status: null };
    }
  }
}
