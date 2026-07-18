import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { AnalysisRepository } from "./db/analyses";
import { EngineClient } from "./engine/client";
import { AnalysisWorker } from "./queue/worker";
import { AnalysisRoutes } from "./routes/analyses";
import { getHealth } from "./routes/health";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const analyses = new AnalysisRepository(db, config.engineVersion);
const engine = new EngineClient(config);
const worker = new AnalysisWorker(config, analyses, engine);
const analysisRoutes = new AnalysisRoutes(config, analyses, () => worker.wake());

worker.start();

async function routeRequest(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/health") {
    return getHealth(config, analyses, engine, worker);
  }
  if (request.method === "POST" && url.pathname === "/v1/analyses") {
    return analysisRoutes.post(request);
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1/analyses/")) {
    const videoId = decodeURIComponent(url.pathname.slice("/v1/analyses/".length));
    return analysisRoutes.get(videoId);
  }
  return Response.json({ error: { code: "not_found", message: "Route not found." } }, { status: 404 });
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 10 * 1024 * 1024,
  async fetch(request) {
    const started = performance.now();
    const url = new URL(request.url);
    let response: Response;

    try {
      response = await routeRequest(request, url);
    } catch (error) {
      console.error(JSON.stringify({
        time: new Date().toISOString(), level: "error", event: "request.failed",
        method: request.method, path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
      }));
      response = Response.json({ error: { code: "internal_error", message: "Internal server error." } }, { status: 500 });
    }

    console.info(JSON.stringify({
      time: new Date().toISOString(), level: "info", event: "request.completed",
      method: request.method, path: url.pathname, status: response.status,
      duration_ms: Math.round((performance.now() - started) * 10) / 10,
    }));
    return response;
  },
});

console.info(JSON.stringify({
  time: new Date().toISOString(), level: "info", event: "api.started",
  address: `http://${config.host}:${server.port}`, engine_url: config.engineUrl,
  engine_version: config.engineVersion, db_path: config.dbPath,
}));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ time: new Date().toISOString(), level: "info", event: "api.stopping", signal }));
  await server.stop(false);
  await worker.stop();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
