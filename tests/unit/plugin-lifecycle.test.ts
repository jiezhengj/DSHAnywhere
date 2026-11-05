
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../packages/plugin/src/index.ts";

function host() {
  const disposers: string[] = [];
  const routes: string[] = [];
  return {
    routes,
    disposers,
    host: {
      webServer: {
        getOrigin: () => "http://127.0.0.1:50743",
        register: (route: { kind: string; path: string }) => {
          routes.push(`${route.kind}:${route.path}`);
          return () => disposers.push(route.path);
        },
        registerUpgrade: () => () => {},
        protocol: "http",
      },
      connection: { authenticatedUrl: (b: string) => b },
      logger: { error: () => {}, info: () => {} },
    },
  };
}

test("dispose 会摘掉注册的路由，允许卸载后重新装配", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "dshanywhere-lifecycle-"));
  const { host: h, routes, disposers } = host();
  const runtime = createRuntime(
    h as never,
    {},
    { storageDir, createSocket: () => ({ send: () => {}, close: () => {}, addEventListener: () => {} }) },
  );
  assert.ok(routes.includes("prefix:/__anywhere"));
  runtime.dispose();
  assert.ok(disposers.includes("/__anywhere"), "路由应被注销");
  assert.ok(disposers.includes("/p"), "配对路由应被注销");
});
