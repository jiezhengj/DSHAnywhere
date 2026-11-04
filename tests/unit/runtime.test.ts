import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../packages/plugin/src/index.ts";

interface Captured {
  route: { kind: string; path: string };
  handler: (req: unknown, res: unknown) => unknown;
}

function host() {
  const routes: Captured[] = [];
  const webServer = {
    getOrigin: () => "http://127.0.0.1:50743",
    register: (route: Captured["route"] & { handler: Captured["handler"] }) => {
      routes.push({ route, handler: route.handler });
      return () => {};
    },
    registerUpgrade: () => () => {},
    protocol: "http",
  };
  const connection = { authenticatedUrl: (base: string) => `${base}/?token=x`, admit: () => true };
  return { host: { webServer, connection, muxPath: "/api/remote.mux" }, routes };
}

function fakeReq(method: string, url: string, body = "") {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    method,
    url,
    headers: { host: "127.0.0.1:50743" },
    on(event: string, cb: (...args: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      if (event === "data" && body) setTimeout(() => cb(body), 0);
      if (event === "end") setTimeout(() => cb(), 1);
    },
  };
}

function fakeRes() {
  const state: { status?: number; headers: Record<string, string>; body: string } = { headers: {}, body: "" };
  return {
    state,
    res: {
      set statusCode(value: number) {
        state.status = value;
      },
      setHeader(name: string, value: string) {
        state.headers[name.toLowerCase()] = value;
      },
      end(body?: string) {
        state.body = body ?? "";
      },
    },
  };
}

async function runtimeWith(config: unknown = { relayUrl: null }) {
  const dir = await mkdtemp(join(tmpdir(), "dshanywhere-rt-"));
  const h = host();
  const runtime = createRuntime(h.host, config, {
    storageDir: dir,
    createSocket: () => ({
      send: () => {},
      close: () => {},
      addEventListener: () => {},
    }),
    now: () => 1_000_000,
  });
  const call = async (method: string, url: string, body = "") => {
    const captured = fakeRes();
    for (const r of h.routes) {
      if (url.startsWith(r.route.path)) {
        await r.handler(fakeReq(method, url, body), captured.res);
        return captured.state;
      }
    }
    throw new Error(`没有匹配的路由：${url}`);
  };
  return { runtime, routes: h.routes, call };
}

test("两个前缀路由被注册到适配层", async () => {
  const { routes } = await runtimeWith();
  assert.deepEqual(
    routes.map((r) => `${r.route.kind}:${r.route.path}`),
    ["prefix:/__anywhere/", "prefix:/p/"],
  );
});

test("未配置时首页给出部署命令", async () => {
  const { call } = await runtimeWith();
  const out = await call("GET", "/__anywhere/");
  assert.equal(out.status, 200);
  assert.match(out.body, /npx wrangler deploy/);
});

test("保存中转地址后返回 303 并落盘", async () => {
  const { runtime, call } = await runtimeWith();
  const out = await call("POST", "/__anywhere/api/relay", "relayUrl=https%3A%2F%2Frelay.example");
  assert.equal(out.status, 303);
  const state = await runtime.store.load();
  assert.equal(state.relay?.url, "https://relay.example");
});

test("非法中转地址返回 400", async () => {
  const { call } = await runtimeWith();
  const out = await call("POST", "/__anywhere/api/relay", "relayUrl=http%3A%2F%2Frelay.example");
  assert.equal(out.status, 400);
});

test("生成配对链接返回 JSON 形式的地址", async () => {
  const { call } = await runtimeWith({ relayUrl: "https://relay.example" });
  const out = await call("POST", "/__anywhere/api/link");
  assert.equal(out.status, 200);
  const payload = JSON.parse(out.body);
  assert.match(payload.pairingUrl, /^https:\/\/relay\.example\/p\/[A-Za-z0-9_-]+$/);
  assert.ok(payload.expiresAt > 1_000_000);
});

test("状态接口返回配置与统计", async () => {
  const { call } = await runtimeWith();
  const out = await call("GET", "/__anywhere/api/status");
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.body).configured, false);
});

test("配对链接可完成配对并只成功一次", async () => {
  const { runtime, call } = await runtimeWith({ relayUrl: "https://relay.example" });
  const link = await call("POST", "/__anywhere/api/link");
  const token = JSON.parse(link.body).pairingUrl.split("/p/")[1];
  const first = await call("GET", `/p/${token}`);
  assert.equal(first.status, 303);
  assert.match(first.headers["set-cookie"] ?? "", /__Host-dshanywhere=/);
  const second = await call("GET", `/p/${token}`);
  assert.equal(second.status, 401);
  const state = await runtime.store.load();
  assert.equal(state.devices.length, 1);
});
