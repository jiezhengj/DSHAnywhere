import { test } from "node:test";
import assert from "node:assert/strict";
import { probeHostSurface } from "../../packages/plugin/src/version.ts";

const full = {
  webServer: {
    getOrigin: () => "http://127.0.0.1:50743",
    register: () => () => {},
    registerUpgrade: () => () => {},
    protocol: "http",
  },
  connection: {
    authenticatedUrl: (base: string) => `${base}/?token=x`,
    admit: () => true,
  },
  muxPath: "/api/remote.mux",
};

test("完整契约面探测通过并返回协议", () => {
  const r = probeHostSurface(full);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.protocol, "http");
});

test("缺少 webServer 时失败", () => {
  const r = probeHostSurface({ ...full, webServer: undefined });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing-webServer");
});

test("缺少 registerUpgrade 时失败（不得半可用）", () => {
  const r = probeHostSurface({
    ...full,
    webServer: { ...full.webServer, registerUpgrade: undefined },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing-registerUpgrade");
});

test("缺少 authenticatedUrl 时失败", () => {
  const r = probeHostSurface({
    ...full,
    connection: { admit: () => true },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing-authenticatedUrl");
});

test("未发现 mux 端点时失败", () => {
  const r = probeHostSurface({ ...full, muxPath: null });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing-mux");
});
