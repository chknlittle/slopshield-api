import type { Config } from "../config";
import { AnalysisRepository, type AnalysisRow } from "../db/analyses";
import { EngineClient, EngineError } from "../engine/client";

const MAX_ATTEMPTS = 3;

function log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ time: new Date().toISOString(), level, event, ...details }));
}

export interface WorkerState {
  state: "idle" | "running" | "stopping" | "stopped";
  concurrency: number;
  active: number;
}

export class AnalysisWorker {
  private readonly abortController = new AbortController();
  private loops: Promise<void>[] = [];
  private readonly waiters = new Set<() => void>();
  private wakeGeneration = 0;
  private active = 0;
  private state: WorkerState["state"] = "idle";

  constructor(
    private readonly config: Config,
    private readonly analyses: AnalysisRepository,
    private readonly engine: EngineClient,
  ) {}

  start(): void {
    if (this.state !== "idle") return;
    const recovered = this.analyses.recoverRunning();
    if (recovered > 0) log("warn", "worker.recovered", { rows: recovered });
    this.state = "running";
    this.loops = Array.from({ length: this.config.workerConcurrency }, (_, index) => this.runLoop(index));
    log("info", "worker.started", { concurrency: this.config.workerConcurrency });
  }

  getState(): WorkerState {
    return { state: this.state, concurrency: this.config.workerConcurrency, active: this.active };
  }

  wake(): void {
    this.wakeGeneration += 1;
    for (const resolve of [...this.waiters]) resolve();
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "idle") return;
    this.state = "stopping";
    this.abortController.abort();
    this.wake();
    await Promise.allSettled(this.loops);
    this.state = "stopped";
    log("info", "worker.stopped");
  }

  private async runLoop(index: number): Promise<void> {
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      const observedGeneration = this.wakeGeneration;
      const row = this.analyses.claimNext();
      if (row === null) {
        await this.waitForWork(observedGeneration, this.analyses.nextRetryAt(), signal);
        continue;
      }
      this.active += 1;
      try {
        await this.process(row, signal);
      } catch (error) {
        log("error", "worker.unexpected_error", {
          worker: index,
          analysis_id: row.id,
          message: error instanceof Error ? error.message : String(error),
        });
        this.analyses.fail(row.id, "analysis_failed", "Unexpected worker failure.");
      } finally {
        this.active -= 1;
      }
    }
  }

  private waitForWork(observedGeneration: number, nextRetryAt: string | null, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.wakeGeneration !== observedGeneration) return Promise.resolve();

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (!this.waiters.delete(finish)) return;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };

      this.waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      if (nextRetryAt !== null) {
        timer = setTimeout(finish, Math.max(0, Date.parse(nextRetryAt) - Date.now()));
      }
    });
  }

  private async process(row: AnalysisRow, signal: AbortSignal): Promise<void> {
    log("info", "analysis.started", { analysis_id: row.id, video_id: row.video_id, attempt: row.attempt_count });

    try {
      if (row.transcript_text === null) {
        throw new EngineError("engine_rejected_request", "Queued analysis has no transcript.", false);
      }
      const result = await this.engine.analyze(row.video_id, row.transcript_text, signal);
      this.analyses.complete(row.id, result.verdict === "ai_suspect", JSON.stringify(result));
      log("info", "analysis.completed", { analysis_id: row.id, video_id: row.video_id, verdict: result.verdict });
    } catch (error) {
      this.handleFailure(row, error);
    }
  }

  private handleFailure(row: AnalysisRow, error: unknown): void {
    const failure = error instanceof EngineError
      ? error
      : new EngineError("analysis_failed", error instanceof Error ? error.message : String(error), false);

    if (failure.transient && row.attempt_count < MAX_ATTEMPTS) {
      this.scheduleRetry(row, failure);
      return;
    }

    this.analyses.fail(row.id, failure.code, failure.message);
    log("error", "analysis.failed", {
      analysis_id: row.id,
      video_id: row.video_id,
      attempts: row.attempt_count,
      code: failure.code,
    });
  }

  private scheduleRetry(row: AnalysisRow, failure: EngineError): void {
    const delayMs = 1_000 * 2 ** (row.attempt_count - 1);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

    this.analyses.retry(row.id, failure.code, failure.message, nextRetryAt);
    this.wake();
    log("warn", "analysis.retry_scheduled", {
      analysis_id: row.id,
      video_id: row.video_id,
      attempt: row.attempt_count,
      delay_ms: delayMs,
      code: failure.code,
    });
  }
}
