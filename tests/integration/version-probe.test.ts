import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../packages/plugin/src/index.ts";

async function dir() {
  return await mkdtemp(join(tmpdir(), "dshanywhere-probe-"));
}

function baseOptions(storageDir: string) {
  return {
    storageDir,
    createSocket: () => ({ send: () => {}, close: () => {}, addEventListener: () => {} }),
  };
}

test("宿主缺少 webServer 时不注册任何路由并记录禁用原因", async () => {
  const errors: string[] = [];
  const routes: unknown[] = [];
  const runtime = createRuntime(
    { logger: { error: (m) => errors.push(m) } },
    {},
    baseOptions(await dir()),
  );
  assert.equal(routes.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /DSHAnywhere 已禁用/);
  assert.equal(runtime.status().connection, "idle");
});

test("缺能力（无 registerUpgrade）同样禁用，不出现半可用", async () => {
  const errors: string[] = [];
  let registered = 0;
  const runtime = createRuntime(
    {
      webServer: {
        getOrigin: () => "http://127.0.0.1:50743",
        register: () => {
          registered += 1;
          return () => {};
        },
        protocol: "http",
      },
      connection: { authenticatedUrl: (b: string) => b, admit: () => true },
      logger: { error: (m) => errors.push(m) },
    },
    {},
    baseOptions(await dir()),
  );
  assert.equal(registered, 0, "能力缺失时不应注册任何路由");
  assert.match(errors[0] ?? "", /已禁用/);
  assert.equal(runtime.store !== undefined, true);
});

test("能力齐备时注册两条前缀路由", async () => {
  const routes: string[] = [];
  const runtime = createRuntime(
    {
      webServer: {
        getOrigin: () => "http://127.0.0.1:50743",
        register: (route: { kind: string; path: string }) => {
          routes.push(`${route.kind}:${route.path}`);
          return () => {};
        },
        registerUpgrade: () => () => {},
        protocol: "http",
      },
      connection: { authenticatedUrl: (b: string) => b, admit: () => true },
      muxPath: "/api/remote.mux",
    },
    {},
    baseOptions(await dir()),
  );
  assert.deepEqual(routes, ["prefix:/__anywhere", "prefix:/p"]);
  assert.ok(runtime);
});
