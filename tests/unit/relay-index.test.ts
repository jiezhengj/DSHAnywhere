import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, isAllowedUpgrade, sanitizeRequestHeaders, resolveInstallId } from "../../packages/relay/src/index.ts";
import type { RelayEnv } from "../../packages/relay/src/index.ts";

function env(): { env: RelayEnv; seen: Request[]; installIds: string[] } {
  const seen: Request[] = [];
  const installIds: string[] = [];
  const e = {
    DSH_INSTALL_ID: "default",
    RELAY_OBJECT: {
      idFromName(name: string) {
        installIds.push(name);
        return { toString: () => name };
      },
      get() {
        return {
          async fetch(request: Request) {
            seen.push(request);
            return new Response("from-do");
          },
        };
      },
    },
  } as unknown as RelayEnv;
  return { env: e, seen, installIds };
}

test("健康检查自答且不落 DO", async () => {
  const h = env();
  const res = await handleRequest(new Request("https://relay.example/__relay/health"), h.env);
  assert.equal(res.status, 200);
  assert.equal(h.seen.length, 0);
  assert.equal((await res.json()).protocolVersion, 1);
});

test("普通路径转发到 DO 并带上 installId", async () => {
  const h = env();
  await handleRequest(new Request("https://relay.example/"), h.env);
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]!.headers.get("x-dsh-install"), "default");
  assert.equal(h.seen[0]!.headers.get("x-dsh-agent"), "0");
});

test("平台痕迹头被剥离，业务头保留", async () => {
  const h = env();
  await handleRequest(
    new Request("https://relay.example/", {
      headers: { "cf-ray": "x", "x-forwarded-for": "1.2.3.4", "sec-fetch-site": "cross-site", "accept-language": "zh-CN" },
    }),
    h.env,
  );
  const headers = h.seen[0]!.headers;
  assert.equal(headers.get("cf-ray"), null);
  assert.equal(headers.get("x-forwarded-for"), null);
  assert.equal(headers.get("sec-fetch-site"), null);
  assert.equal(headers.get("accept-language"), "zh-CN");
});

test("agent 通道非 WS 升级被拒", async () => {
  const h = env();
  const res = await handleRequest(new Request("https://relay.example/__dsh_agent"), h.env);
  assert.equal(res.status, 400);
  assert.equal(h.seen.length, 0);
});

test("非白名单路径的 WS 升级返回 404", async () => {
  const h = env();
  const res = await handleRequest(
    new Request("https://relay.example/some/other", { headers: { upgrade: "websocket" } }),
    h.env,
  );
  assert.equal(res.status, 404);
  assert.equal(h.seen.length, 0);
});

test("白名单路径 /api/remote.mux 允许透传", async () => {
  const h = env();
  await handleRequest(
    new Request("https://relay.example/api/remote.mux", { headers: { upgrade: "websocket" } }),
    h.env,
  );
  assert.equal(h.seen.length, 1);
});

test("install 查询参数优先于默认值", async () => {
  const h = env();
  await handleRequest(new Request("https://relay.example/?install=abc"), h.env);
  assert.equal(h.installIds[0], "abc");
  assert.equal(resolveInstallId(new URL("https://relay.example/"), h.env), "default");
});

test("sanitizeRequestHeaders 不修改原对象", () => {
  const original = new Headers({ "cf-ray": "x", accept: "text/html" });
  const cleaned = sanitizeRequestHeaders(original);
  assert.equal(original.get("cf-ray"), "x");
  assert.equal(cleaned.get("cf-ray"), null);
});

test("isAllowedUpgrade 只放行 mux 路径", () => {
  assert.equal(isAllowedUpgrade("/api/remote.mux"), true);
  assert.equal(isAllowedUpgrade("/api/other"), false);
});

test("Cloudflare 剥掉 Upgrade 头时仍能识别升级请求", async () => {
  const h = env();
  const res = await handleRequest(
    new Request("https://relay.example/api/remote.mux", {
      headers: { connection: "Upgrade", "sec-websocket-key": "abc", "sec-websocket-version": "13" },
    }),
    h.env,
  );
  assert.equal(h.seen.length, 1, "升级请求应转发到 DO");
  // 升级请求必须原样转交，否则会丢失升级语义
  assert.equal(h.seen[0]!.headers.get("sec-websocket-key"), "abc");
  assert.equal(h.seen[0]!.headers.get("x-dsh-upgrade"), null);
});

test("只有 sec-websocket-key 也能识别为升级", async () => {
  const h = env();
  await handleRequest(
    new Request("https://relay.example/api/remote.mux", { headers: { "sec-websocket-key": "abc" } }),
    h.env,
  );
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]!.headers.get("sec-websocket-key"), "abc");
});

test("非升级请求走普通浏览器分支", async () => {
  const h = env();
  const res = await handleRequest(new Request("https://relay.example/"), h.env);
  assert.equal(await res.text(), "from-do");
});
