import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePairing } from "../../packages/plugin/src/pairing.ts";
import { createLink, nextLinkRecord } from "../../packages/plugin/src/link.ts";
import { emptyState } from "../../packages/plugin/src/store.ts";
import type { StoreState } from "../../packages/plugin/src/store.ts";
import { hashCredential, verifyCredential } from "../../packages/plugin/src/devices.ts";

function stateWithLink(now = 1_000): { state: StoreState; token: string } {
  const { link, record } = createLink(now);
  return { state: { ...emptyState(), link: nextLinkRecord(null, record) }, token: link.token };
}

test("有效链接配对成功：303 + HttpOnly cookie + 设备入表", () => {
  const { state, token } = stateWithLink();
  const out = handlePairing(`/p/${token}`, state, { now: 2_000 });
  assert.equal(out.status, 303);
  assert.equal(out.headers.location, "/");
  const cookie = out.headers["set-cookie"] ?? "";
  assert.match(cookie, /^__Host-dshanywhere=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.equal(out.nextState?.devices.length, 1);
  assert.equal(out.nextState?.link, null);
});

test("下发的凭证能被校验通过", () => {
  const { state, token } = stateWithLink();
  const out = handlePairing(`/p/${token}`, state, { now: 2_000 });
  const credential = (out.headers["set-cookie"] ?? "").split(";")[0]!.split("=")[1]!;
  assert.ok(verifyCredential(out.nextState!, credential));
});

test("存储里只保留凭证摘要", () => {
  const { state, token } = stateWithLink();
  const out = handlePairing(`/p/${token}`, state, { now: 2_000 });
  const credential = (out.headers["set-cookie"] ?? "").split(";")[0]!.split("=")[1]!;
  const stored = JSON.stringify(out.nextState);
  assert.ok(!stored.includes(credential));
  assert.ok(stored.includes(hashCredential(credential)));
});

test("过期链接返回统一措辞 401", () => {
  const { state, token } = stateWithLink(1_000);
  const out = handlePairing(`/p/${token}`, state, { now: 1_000 + 10 * 60 * 1000 });
  assert.equal(out.status, 401);
  assert.match(out.body, /链接无效或已过期/);
  assert.equal(out.nextState, undefined);
});

test("重复使用同一链接只有第一次成功", () => {
  const { state, token } = stateWithLink();
  const first = handlePairing(`/p/${token}`, state, { now: 2_000 });
  assert.equal(first.status, 303);
  const second = handlePairing(`/p/${token}`, first.nextState!, { now: 2_000 });
  assert.equal(second.status, 401);
});

test("不存在的链接与过期链接文案一致（不泄露是否存在）", () => {
  const empty = emptyState();
  const missing = handlePairing("/p/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", empty);
  const { state, token } = stateWithLink(1_000);
  const expired = handlePairing(`/p/${token}`, state, { now: 1_000 + 600_001 });
  assert.equal(missing.body, expired.body);
  assert.equal(missing.status, expired.status);
});

test("达到设备上限时拒绝并保留链接已消费语义", () => {
  const { state, token } = stateWithLink();
  const full: StoreState = {
    ...state,
    devices: Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      label: `设备 ${i}`,
      credentialHash: "x",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    })),
  };
  const out = handlePairing(`/p/${token}`, full, { now: 2_000 });
  assert.equal(out.status, 403);
  assert.match(out.body, /最多配对 10 台/);
  assert.equal(out.nextState?.link, null);
});

test("已撤销设备不占名额", () => {
  const { state, token } = stateWithLink();
  const withRevoked: StoreState = {
    ...state,
    devices: Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      label: `设备 ${i}`,
      credentialHash: "x",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      revokedAt: "2026-01-02T00:00:00.000Z",
    })),
  };
  assert.equal(handlePairing(`/p/${token}`, withRevoked, { now: 2_000 }).status, 303);
});

test("非 https 场景不下发 Secure", () => {
  const { state, token } = stateWithLink();
  const out = handlePairing(`/p/${token}`, state, { now: 2_000, secure: false });
  assert.doesNotMatch(out.headers["set-cookie"] ?? "", /Secure/);
});

test("入口始终带 no-store 与 no-referrer", () => {
  const { state, token } = stateWithLink();
  const out = handlePairing(`/p/${token}`, state, { now: 2_000 });
  assert.equal(out.headers["cache-control"], "no-store");
  assert.equal(out.headers["referrer-policy"], "no-referrer");
});

test("非法路径返回 404 且不泄露细节", () => {
  const out = handlePairing("/p/short", emptyState());
  assert.equal(out.status, 404);
  assert.match(out.body, /链接无效或已过期/);
});
