import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRelayUrl, pairingUrl } from "../../packages/plugin/src/relay-url.ts";

test("接受标准 https 地址并归一末尾斜杠", () => {
  const r = normalizeRelayUrl("https://relay.example");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.origin, "https://relay.example");
    assert.equal(r.url, "https://relay.example/");
  }
});

test("去掉首尾空白并小写主机名", () => {
  const r = normalizeRelayUrl("  HTTPS://Relay.Example/  ");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.origin, "https://relay.example");
});

test("允许 localhost 的 http（本机调试）", () => {
  assert.equal(normalizeRelayUrl("http://127.0.0.1:8787").ok, true);
  assert.equal(normalizeRelayUrl("http://localhost:8787").ok, true);
});

test("拒绝非 https 的公网地址", () => {
  const r = normalizeRelayUrl("http://relay.example");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "invalid-url");
});

test("拒绝带路径的地址", () => {
  assert.equal(normalizeRelayUrl("https://relay.example/foo").ok, false);
});

test("拒绝带查询串或片段的地址", () => {
  assert.equal(normalizeRelayUrl("https://relay.example/?a=1").ok, false);
  assert.equal(normalizeRelayUrl("https://relay.example/#x").ok, false);
});

test("拒绝空值与非字符串", () => {
  assert.equal(normalizeRelayUrl("   ").ok, false);
  assert.equal(normalizeRelayUrl(undefined).ok, false);
  assert.equal(normalizeRelayUrl(42).ok, false);
});

test("拒绝非法 URL", () => {
  assert.equal(normalizeRelayUrl("not a url").ok, false);
});

test("配对入口拼接正确", () => {
  assert.equal(pairingUrl("https://relay.example", "abc"), "https://relay.example/p/abc");
  assert.equal(pairingUrl("https://relay.example/", "abc"), "https://relay.example/p/abc");
});
