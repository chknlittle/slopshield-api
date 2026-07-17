import type { Config } from "../config";
import { AnalysisRepository } from "../db/analyses";
import { EngineClient } from "../engine/client";
import { AnalysisWorker } from "../queue/worker";

export async function getHealth(
  config: Config,
  analyses: AnalysisRepository,
  engine: EngineClient,
  worker: AnalysisWorker,
): Promise<Response> {
  const engineHealth = await engine.reachable();
  return Response.json({
    ok: true,
    engine: {
      url: config.engineUrl,
      version: config.engineVersion,
      reachable: engineHealth.reachable,
      http_status: engineHealth.status,
    },
    worker: worker.getState(),
    queue: analyses.counts(),
    time: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
