import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOW_MS, recordOutcome, windowStats } from "../../packages/plugin/src/stats.ts";
import { emptyState } from "../../packages/plugin/src/store.ts";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

test("窗口内计数与可访问率", () => {
  const stats = { since: new Date(NOW - 1000).toISOString(), success: 9, failure: 1 };
  const snap = windowStats(stats, NOW);
  assert.equal(snap.total, 10);
  assert.equal(snap.availability, 0.9);
  assert.equal(snap.since, stats.since);
});

test("空统计的可用率为 1", () => {
  assert.equal(windowStats({ since: new Date(NOW).toISOString(), success: 0, failure: 0 }, NOW).availability, 1);
});

test("超过 24 小时窗口自动归零", () => {
  const stats = { since: new Date(NOW - WINDOW_MS - 1).toISOString(), success: 100, failure: 5 };
  const snap = windowStats(stats, NOW);
  assert.equal(snap.total, 0);
  assert.equal(snap.since, new Date(NOW).toISOString());
});

test("窗口起点无法解析时按新窗口处理", () => {
  const snap = windowStats({ since: "not-a-date", success: 3, failure: 0 }, NOW);
  assert.equal(snap.total, 0);
});

test("recordOutcome 累计成功与失败", () => {
  let state = { ...emptyState(), stats: { since: new Date(NOW - 1000).toISOString(), success: 0, failure: 0 } };
  state = recordOutcome(state, "success", NOW);
  state = recordOutcome(state, "success", NOW);
  state = recordOutcome(state, "failure", NOW);
  assert.equal(state.stats.success, 2);
  assert.equal(state.stats.failure, 1);
  assert.equal(state.stats.lastSuccessAt, new Date(NOW).toISOString());
});

test("跨窗口后重新开始计数", () => {
  const old = { ...emptyState(), stats: { since: new Date(NOW - WINDOW_MS - 5).toISOString(), success: 50, failure: 0 } };
  const next = recordOutcome(old, "failure", NOW);
  assert.equal(next.stats.success, 0);
  assert.equal(next.stats.failure, 1);
  assert.equal(next.stats.since, new Date(NOW).toISOString());
});
