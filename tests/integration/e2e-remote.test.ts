import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Gateway } from "../../packages/plugin/src/gateway.ts";
import { RelayBridge } from "../../packages/relay/src/bridge.ts";
import type { HttpSink } from "../../packages/relay/src/bridge.ts";
import { decodeFrame } from "../../packages/protocol/src/index.ts";

/**
 * 本机端到端：中转(Rebridge) ↔ 帧协议 ↔ 网关(Gateway) ↔ loopback HTTP。
 * 不依赖 Cloudflare 与真实 DSH，但走的是与生产完全相同的帧路径。
 */
async function stack(handler: (req: import("node:http").IncomingMessage, body: string) => { status?: number; headers?: Record<string, string>; body: string | Uint8Array }) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const result = handler(req, Buffer.concat(chunks).toString("utf8"));
      res.writeHead(result.status ?? 200, result.headers ?? {});
      res.end(result.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  let relaySide!: RelayBridge;
  const gateway = new Gateway({
    loopbackOrigin: origin,
    mintHostCookie: async () => "dsh-auth-x=test",
    send: (bytes) => {
      const frame = decodeFrame(bytes);
      queueMicrotask(() => relaySide.onFrame(frame));
    },
  });
  relaySide = new RelayBridge({
    send: (bytes) => {
      const frame = decodeFrame(bytes);
      queueMicrotask(() => void gateway.onFrame(frame));
    },
    close: () => {},
  });

  return { origin, relaySide, gateway, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function sinkOf(): { sink: HttpSink; result: Promise<{ status: number; headers: Record<string, string>; body: string }> } {
  let resolve!: (v: { status: number; headers: Record<string, string>; body: string }) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<{ status: number; headers: Record<string, string>; body: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let status = 0;
  let headers: Record<string, string> = {};
  const chunks: Uint8Array[] = [];
  const sink: HttpSink = {
    head: (s, h) => {
      status = s;
      headers = h;
    },
    body: (chunk) => chunks.push(chunk),
    end: () => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        joined.set(c, offset);
        offset += c.byteLength;
      }
      resolve({ status, headers, body: new TextDecoder().decode(joined) });
    },
    fail: (code) => reject(new Error(code)),
  };
  return { sink, result };
}

test("浏览器请求经中转与帧协议到达 loopback 并原样返回", async () => {
  const stackRef = await stack((req) => ({
    headers: { "content-type": "text/html" },
    body: `<html>${req.url}</html>`,
  }));
  try {
    const { sink, result } = sinkOf();
    stackRef.relaySide.request({ method: "GET", path: "/", headers: { accept: "text/html" } }, null, sink);
    const res = await result;
    assert.equal(res.status, 200);
    assert.equal(res.body, "<html>/</html>");
  } finally {
    await stackRef.close();
  }
});

test("上行请求体完整送达 loopback", async () => {
  let received = "";
  const stackRef = await stack((_req, body) => {
    received = body;
    return { headers: { "content-type": "text/plain" }, body: "echo" };
  });
  try {
    const { sink, result } = sinkOf();
    stackRef.relaySide.request(
      { method: "POST", path: "/api/input", headers: { "content-type": "text/plain" } },
      new TextEncoder().encode("你好，世界"),
      sink,
    );
    await result;
    assert.equal(received, "你好，世界");
  } finally {
    await stackRef.close();
  }
});

test("大响应体被分片后仍能完整重组", async () => {
  const big = "x".repeat(200_000);
  const stackRef = await stack(() => ({ headers: { "content-type": "text/plain" }, body: big }));
  try {
    const { sink, result } = sinkOf();
    stackRef.relaySide.request({ method: "GET", path: "/history", headers: {} }, null, sink);
    const res = await result;
    assert.equal(res.body.length, 200_000);
    assert.equal(res.body, big);
  } finally {
    await stackRef.close();
  }
});

test("宿主 cookie 被注入到 loopback 请求", async () => {
  let cookie = "";
  const stackRef = await stack((req) => {
    cookie = String(req.headers.cookie ?? "");
    return { body: "ok" };
  });
  try {
    const { sink, result } = sinkOf();
    stackRef.relaySide.request({ method: "GET", path: "/", headers: { cookie: "__Host-dshanywhere=browser" } }, null, sink);
    await result;
    assert.equal(cookie, "dsh-auth-x=test");
  } finally {
    await stackRef.close();
  }
});

test("loopback 401 触发换发 cookie 后重试成功", async () => {
  let calls = 0;
  const stackRef = await stack(() => {
    calls += 1;
    return calls === 1 ? { status: 401, body: "no" } : { body: "ok" };
  });
  try {
    const { sink, result } = sinkOf();
    stackRef.relaySide.request({ method: "GET", path: "/", headers: {} }, null, sink);
    const res = await result;
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    await stackRef.close();
  }
});
