
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeHostSurface } from "../../packages/plugin/src/version.ts";

test("契约探测：缺 registerUpgrade 即视为不兼容", () => {
  const result = probeHostSurface({
    webServer: { getOrigin: () => "x", register: () => {}, protocol: "http" },
    connection: { authenticatedUrl: () => "x" },
    muxPath: "/api/remote.mux",
  } as never);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "missing-registerUpgrade");
});

test("契约探测：四项齐备才通过", () => {
  const result = probeHostSurface({
    webServer: { getOrigin: () => "x", register: () => {}, registerUpgrade: () => {}, protocol: "http" },
    connection: { authenticatedUrl: () => "x" },
    muxPath: "/api/remote.mux",
  } as never);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.protocol, "http");
});
