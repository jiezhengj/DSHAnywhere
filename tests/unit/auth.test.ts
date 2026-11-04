import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authenticate,
  availability,
  deviceCookie,
  readCookie,
  recordFailure,
  recordSuccess,
  rotateLinks,
  setEnabled,
} from "../../packages/plugin/src/auth.ts";
import { createDevice } from "../../packages/plugin/src/devices.ts";
import { createLink, nextLinkRecord } from "../../packages/plugin/src/link.ts";
import { emptyState } from "../../packages/plugin/src/store.ts";

function paired() {
  const { device, credential } = createDevice("iPhone", 1_000);
  const state = { ...emptyState(), devices: [device] };
  return { state, credential, device };
}

test("已配对凭证通过校验并返回设备", () => {
  const { state, credential } = paired();
  const result = authenticate(state, credential);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.device.label, "iPhone");
});

test("没有 cookie 视为未配对", () => {
  const { state } = paired();
  const result = authenticate(state, null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unpaired");
});

test("错误凭证与已撤销凭证都被拒", () => {
  const { state, credential, device } = paired();
  assert.equal(authenticate(state, "bogus").ok, false);
  device.revokedAt = new Date(2_000).toISOString();
  assert.equal(authenticate(state, credential).ok, false);
});

test("关闭后即使凭证正确也被拒", () => {
  const { state, credential } = paired();
  const disabled = setEnabled(state, false);
  const result = authenticate(disabled, credential);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "disabled");
});

test("撤销立即生效：同一凭证下一个请求即失败（无缓存）", () => {
  const { state, credential, device } = paired();
  assert.equal(authenticate(state, credential).ok, true);
  device.revokedAt = new Date(3_000).toISOString();
  assert.equal(authenticate(state, credential).ok, false);
});

test("cookie 形如 __Host- 约束", () => {
  const cookie = deviceCookie("abc", { secure: true, maxAgeDays: 30 });
  assert.match(cookie, /^__Host-dshanywhere=abc/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.match(cookie, /Max-Age=2592000/);
});

test("非 TLS 场景不带 Secure", () => {
  assert.doesNotMatch(deviceCookie("abc", { secure: false }), /Secure/);
});

test("readCookie 能取出指定名字", () => {
  const headers = { cookie: "a=1; __Host-dshanywhere=xyz; b=2" };
  assert.equal(readCookie(headers, "__Host-dshanywhere"), "xyz");
  assert.equal(readCookie(headers, "missing"), null);
  assert.equal(readCookie({}, "__Host-dshanywhere"), null);
});

test("轮换作废未用链接但不动设备", () => {
  const { state: base, device } = paired();
  const { record } = createLink(5_000);
  const state = { ...base, link: nextLinkRecord(null, record), linkEpoch: 3 };
  const rotated = rotateLinks(state, 6_000);
  assert.equal(rotated.revokedLinks, 1);
  assert.equal(rotated.devicesUnaffected, 1);
  assert.equal(rotated.state.link, null);
  assert.equal(rotated.state.linkEpoch, 4);
  assert.equal(rotated.state.devices[0]?.id, device.id);
});

test("没有可用链接时轮换计数为 0", () => {
  const rotated = rotateLinks(emptyState());
  assert.equal(rotated.revokedLinks, 0);
});

test("统计记录与可用率", () => {
  let state = emptyState();
  const { device } = createDevice("iPhone", 1_000);
  state = { ...state, devices: [device] };
  state = recordSuccess(state, device.id, new Date(2_000));
  state = recordFailure(state);
  assert.equal(state.stats.success, 1);
  assert.equal(state.stats.failure, 1);
  assert.equal(state.devices[0]?.requestCount, 1);
  assert.equal(availability(state.stats), 0.5);
  assert.equal(availability(emptyState().stats), 1);
});
