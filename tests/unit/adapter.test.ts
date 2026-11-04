import { test } from "node:test";
import assert from "node:assert/strict";
import { Adapter, ContractViolation } from "../../packages/plugin/src/adapter.ts";

function surface(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const webServer = {
    getOrigin: () => "http://127.0.0.1:50743",
    register: (route: unknown) => {
      calls.push(route);
      return () => {};
    },
    registerUpgrade: (route: unknown) => {
      calls.push(route);
      return () => {};
    },
    protocol: "http",
  };
  const connection = {
    authenticatedUrl: (base: string) => `${base}/?token=abc`,
    admit: () => true,
  };
  return { surface: { webServer, connection, muxPath: "/api/remote.mux", ...overrides }, calls };
}

test("契约不完整时构造即抛 ContractViolation", () => {
  assert.throws(
    () => new Adapter({ webServer: undefined, connection: {}, muxPath: null }),
    (err: unknown) => err instanceof ContractViolation,
  );
});

test("registerRoute 透传 kind 与 path 并返回 disposer", () => {
  const { surface: s, calls } = surface();
  const adapter = new Adapter(s);
  const dispose = adapter.registerRoute("prefix", "/__anywhere/", () => {});
  assert.equal(typeof dispose, "function");
  assert.deepEqual((calls[0] as { kind: string }).kind, "prefix");
});

test("getLoopbackOrigin 返回宿主 origin", () => {
  const { surface: s } = surface();
  assert.equal(new Adapter(s).getLoopbackOrigin(), "http://127.0.0.1:50743");
});

test("mintHostCookie 从 303 的 Set-Cookie 提取 dsh-auth 值", async () => {
  const { surface: s } = surface();
  const fetchImpl = (async () =>
    new Response(null, {
      status: 303,
      headers: { "set-cookie": "dsh-auth-x=token123; Path=/; HttpOnly" },
    })) as unknown as typeof fetch;
  const adapter = new Adapter(s, { fetchImpl });
  assert.equal(await adapter.mintHostCookie(), "dsh-auth-x=token123");
});

test("mintHostCookie 命中缓存时不重复请求", async () => {
  const { surface: s } = surface();
  let hits = 0;
  const fetchImpl = (async () => {
    hits += 1;
    return new Response(null, {
      status: 303,
      headers: { "set-cookie": "dsh-auth-x=v1; Path=/" },
    });
  }) as unknown as typeof fetch;
  const adapter = new Adapter(s, { fetchImpl });
  await adapter.mintHostCookie();
  await adapter.mintHostCookie();
  assert.equal(hits, 1);
});

test("mintHostCookie 未返回 cookie 时抛错", async () => {
  const { surface: s } = surface();
  const fetchImpl = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
  const adapter = new Adapter(s, { fetchImpl });
  await assert.rejects(() => adapter.mintHostCookie(), /未返回 dsh-auth/);
});
