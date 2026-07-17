export interface TextPick {
  start: number;
  end: number;
  start_ts: string;
  end_ts: string;
  score: number;
  leaf_score: number;
  context_seconds: number;
  text: string;
}

export interface EngineAnalysis {
  video_id: string;
  verdict: "ai_suspect" | "most likely not AI";
  max_text_score: number | null;
  text_scale_scores: Record<string, number> | null;
  text_pick: TextPick | null;
  spoof: number | null;
  saved_audio: string | null;
  [key: string]: unknown;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableFinite(value: unknown): boolean {
  return value === null || finiteNumber(value);
}

function validScaleScores(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  return Object.values(value).every(finiteNumber);
}

function validTextPick(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;

  const pick = value as Record<string, unknown>;
  const scores = [pick.start, pick.end, pick.score, pick.leaf_score, pick.context_seconds];
  if (!scores.every(finiteNumber)) return false;
  return typeof pick.start_ts === "string"
    && typeof pick.end_ts === "string"
    && typeof pick.text === "string";
}

export function isEngineAnalysis(value: unknown, expectedVideoId: string): value is EngineAnalysis {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;
  if (item.video_id !== expectedVideoId) return false;
  if (item.verdict !== "ai_suspect" && item.verdict !== "most likely not AI") return false;
  if (!nullableFinite(item.max_text_score) || !nullableFinite(item.spoof)) return false;
  if (item.saved_audio !== null && typeof item.saved_audio !== "string") return false;
  if (!validScaleScores(item.text_scale_scores)) return false;
  return validTextPick(item.text_pick);
}
