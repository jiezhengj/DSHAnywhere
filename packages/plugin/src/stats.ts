import type { AccessStats, StoreState } from "./store.ts";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface StatsSnapshot {
  since: string;
  success: number;
  failure: number;
  total: number;
  availability: number;
}

function snapshot(stats: AccessStats): StatsSnapshot {
  const total = stats.success + stats.failure;
  return {
    since: stats.since,
    success: stats.success,
    failure: stats.failure,
    total,
    availability: total === 0 ? 1 : Number((stats.success / total).toFixed(3)),
  };
}

/** 24 小时滑动窗口：窗口过期则归零，避免历史累计淹没近期状态 */
export function windowStats(stats: AccessStats, now: number, windowMs: number = WINDOW_MS): StatsSnapshot {
  const since = Date.parse(stats.since);
  if (!Number.isFinite(since) || now - since >= windowMs) {
    return snapshot({ since: new Date(now).toISOString(), success: 0, failure: 0 });
  }
  return snapshot(stats);
}

/** 记一次成功/失败；只记计数，不记 URL 或正文 */
export function recordOutcome(
  state: StoreState,
  outcome: "success" | "failure",
  now: number,
): StoreState {
  const rolled = windowStats(state.stats, now);
  const base: AccessStats =
    rolled.total === 0 && rolled.since !== state.stats.since
      ? { since: rolled.since, success: 0, failure: 0 }
      : { ...state.stats };
  if (outcome === "success") base.success += 1;
  else base.failure += 1;
  if (outcome === "success") base.lastSuccessAt = new Date(now).toISOString();
  return { ...state, stats: base };
}
