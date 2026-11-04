import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusPayload, handleStatusApi } from "../../packages/plugin/src/status.ts";
import type { StatusContext } from "../../packages/plugin/src/status.ts";
import { createDevice } from "../../packages/plugin/src/devices.ts";
import { emptyState } from "../../packages/plugin/src/store.ts";
import type { StoreState } from "../../packages/plugin/src/store.ts";

function ctx(state: StoreState = emptyState(), patch: Partial<StatusContext> = {}): StatusContext {
  return {
    state,
    relayUrl: null,
    connection: "idle",
    relayOrigin: null,
    installId: "abc123",
    contractVersion: { expected: "0.2.x", actual: "0.2.1-rc.5" },
    now: () => 1_000_000,
    secure: true,
    ...patch,
  };
}

test("GET status 返回契约字段", () => {
  const out = handleStatusApi("GET", "/__anywhere/api/status", "", ctx());
  const body = JSON.parse(out.body);
  assert.equal(out.status, 200);
  assert.equal(body.installation.installId, "abc123");
  assert.equal(body.installation.state, "unconfigured");
  assert.equal(body.stats.window.availability, 1);
  assert.equal(body.limits.maxDevices, 10);
});

test("POST relay 规范化并给出 rebuild 副作用", () => {
  const out = handleStatusApi("POST", "/__anywhere/api/relay", JSON.stringify({ url: "https://R.example/" }), ctx());
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.body).ok, true);
  assert.equal(out.nextState?.relay?.url, "https://r.example");
  assert.equal(out.effect, "rebuild-tunnel");
});

test("POST relay 非法地址返回 invalid-url", () => {
  const out = handleStatusApi("POST", "/__anywhere/api/relay", JSON.stringify({ url: "ftp://x" }), ctx());
  assert.equal(out.status, 400);
  assert.equal(JSON.parse(out.body).error.code, "invalid-url");
});

test("未配置中转时生成链接返回 relay-not-configured", () => {
  const out = handleStatusApi("POST", "/__anywhere/api/link", "", ctx());
  assert.equal(out.status, 409);
  assert.equal(JSON.parse(out.body).error.code, "relay-not-configured");
});

test("POST link 返回明文 pairUrl 且落盘只存摘要", () => {
  const out = handleStatusApi("POST", "/__anywhere/api/link", "", ctx(emptyState(), { relayUrl: "https://relay.example" }));
  const body = JSON.parse(out.body);
  const token = body.pairUrl.split("/p/")[1];
  assert.equal(out.nextState?.link?.tokenHash.includes(token), false);
  assert.equal(out.nextState?.link !== null, true);
});

test("同一时刻只有一条 active 链接", () => {
  const first = handleStatusApi("POST", "/__anywhere/api/link", "", ctx(emptyState(), { relayUrl: "https://r.example" }));
  const second = handleStatusApi("POST", "/__anywhere/api/link", "", ctx(first.nextState!, { relayUrl: "https://r.example" }));
  const token1 = JSON.parse(first.body).pairUrl.split("/p/")[1];
  const token2 = JSON.parse(second.body).pairUrl.split("/p/")[1];
  assert.notEqual(token1, token2);
  assert.equal(second.nextState?.link?.epoch, (first.nextState?.link?.epoch ?? 0) + 1);
});

test("POST rotate 递增 epoch 且不清设备", () => {
  const device = createDevice("iPhone", 1_000).device;
  const state = { ...emptyState(), devices: [device] };
  const out = handleStatusApi("POST", "/__where/api/rotate".replace("/__where", "/__anywhere"), "", ctx(state));
  assert.equal(out.status, 200);
  const body = JSON.parse(out.body);
  assert.equal(body.devicesUnaffected, 1);
  assert.equal(out.nextState?.linkEpoch, 1);
  assert.equal(out.nextState?.devices[0]?.id, device.id);
});

test("撤销设备成功，撤销最后一台给出 no-active-device", () => {
  const { device } = createDevice("iPhone", 1_000);
  const state = { ...emptyState(), devices: [device] };
  const out = handleStatusApi("POST", `/__anywhere/api/devices/${device.id}/revoke`, "", ctx(state));
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.body).warning, "no-active-device");
  assert.equal(out.nextState?.devices[0]?.revokedAt !== undefined, true);
});

test("撤销不存在的设备返回 not-found", () => {
  const out = handleStatusApi("POST", "/__anywhere/api/devices/nope/revoke", "", ctx());
  assert.equal(out.status, 404);
  assert.equal(JSON.parse(out.body).error.code, "not-found");
});

test("撤销后仍有其它设备时不带 warning", () => {
  const a = createDevice("A", 1_000).device;
  const b = createDevice("B", 1_000).device;
  const state = { ...emptyState(), devices: [a, b] };
  const out = handleStatusApi("POST", `/__anywhere/api/devices/${a.id}/revoke`, "", ctx(state));
  assert.deepEqual(JSON.parse(out.body), { ok: true });
});

test("enable/disable 给出对应副作用", () => {
  const off = handleStatusApi("POST", "/__anywhere/api/disable", "", ctx());
  assert.equal(off.nextState?.enabled, false);
  assert.equal(off.effect, "stop-tunnel");
  const on = handleStatusApi("POST", "/__anywhere/api/enable", "", ctx(off.nextState!));
  assert.equal(on.nextState?.enabled, true);
  assert.equal(on.effect, "start-tunnel");
});

test("未知接口返回 not-found", () => {
  const out = handleStatusApi("GET", "/__anywhere/api/nope", "", ctx());
  assert.equal(out.status, 404);
});

test("状态载荷列出设备状态与请求数", () => {
  const { device } = createDevice("iPhone", 1_000);
  const payload = buildStatusPayload(ctx({ ...emptyState(), devices: [{ ...device, requestCount: 7 }] }));
  const devices = payload["devices"] as { state: string; requestCount: number }[];
  assert.equal(devices[0]?.state, "active");
  assert.equal(devices[0]?.requestCount, 7);
});
