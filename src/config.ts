export interface Config {
  host: string;
  port: number;
  dbPath: string;
  engineVersion: string;
  engineUrl: string;
  workerConcurrency: number;
  engineTimeoutMs: number;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requiredString(name: string, fallback: string): string {
  const value = Bun.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} must not be empty`);
  return value;
}

export function loadConfig(): Config {
  const engineUrl = requiredString("SLOPSHIELD_ENGINE_URL", "http://192.168.0.129:8765").replace(/\/+$/, "");
  new URL(engineUrl);

  return {
    host: requiredString("SLOPSHIELD_HOST", "0.0.0.0"),
    port: integer("SLOPSHIELD_PORT", 3000, 1, 65535),
    dbPath: requiredString("SLOPSHIELD_DB_PATH", "./data/slopshield.sqlite3"),
    engineVersion: requiredString("SLOPSHIELD_ENGINE_VERSION", "v1"),
    engineUrl,
    workerConcurrency: integer("SLOPSHIELD_WORKER_CONCURRENCY", 2, 1, 32),
    engineTimeoutMs: integer("SLOPSHIELD_ENGINE_TIMEOUT_MS", 300_000, 1_000, 3_600_000),
  };
}
