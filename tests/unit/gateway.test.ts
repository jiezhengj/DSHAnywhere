import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../../packages/plugin/src/gateway.ts";
import type { WsClientLike } from "../../packages/plugin/src/gateway.ts";
import { FrameType, decodeFrame, encodeFrame, encodeJson } from "../../packages/protocol/src/index.ts";
import type { Frame } from "../../packages/protocol/src/index.ts";

function harness(fetchImpl: typeof fetch) {
  const sentFrames: Frame[] = [];
  const gateway = new Gateway({
    loopbackOrigin: "http://127.0.0.1:50743",
    mintHostCookie: async () => "dsh-auth-x=abc",
    send: (bytes) => sentFrames.push(decodeFrame(bytes)),
    fetchImpl,
  });
  return { gateway, sentFrames };
}

function head(id: number, path = "/", headers: Record<string, string> = {}): Frame {
  return {
    type: FrameType.HTTP_REQUEST_HEAD,
    streamId: id,
    flags: 0,
    payload: encodeJson({ method: "GET", path, headers }),
  };
}

test("GET 请求产生 head/body/end 三类响应帧", async () => {
  const { gateway, sentFrames } = harness(async () =>
    new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  await gateway.onFrame(head(1));
  await gateway.onFrame({ type: FrameType.HTTP_REQUEST_END, streamId: 1, flags: 0, payload: new Uint8Array() });

  const types = sentFrames.map((f) => f.type);
  assert.equal(types[0], FrameType.HTTP_RESPONSE_HEAD);
  assert.equal(types.at(-1), FrameType.HTTP_RESPONSE_END);
  const headPayload = JSON.parse(new TextDecoder().decode(sentFrames[0]!.payload));
  assert.equal(headPayload.status, 200);
  assert.equal(headPayload.headers["content-type"], "text/html");
});

test("请求体被拼接后发送给 loopback", async () => {
  let received = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    received = new TextDecoder().decode(init.body as ArrayBuffer);
    return new Response("ok");
  }) as unknown as typeof fetch;
  const { gateway } = harness(fetchImpl);
  await gateway.onFrame({
    type: FrameType.HTTP_REQUEST_HEAD,
    streamId: 2,
    flags: 0,
    payload: encodeJson({ method: "POST", path: "/api", headers: {} }),
  });
  await gateway.onFrame({ type: FrameType.HTTP_REQUEST_BODY, streamId: 2, flags: 0, payload: new TextEncoder().encode("hello ") });
  await gateway.onFrame({ type: FrameType.HTTP_REQUEST_BODY, streamId: 2, flags: 0, payload: new TextEncoder().encode("world") });
  await gateway.onFrame({ type: FrameType.HTTP_REQUEST_END, streamId: 2, flags: 0, payload: new Uint8Array() });
  assert.equal(received, "hello world");
});

test("loopback 返回 401 时换发 cookie 重试一次", async () => {
  let calls = 0;
  const cookies: string[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    calls += 1;
    cookies.push((init.headers as Record<string, string>).cookie ?? "");
    return calls === 1 ? new Response("401", { status: 401 }) : new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const sent: Frame[] = [];
  const gateway = new Gateway({
    loopbackOrigin: "http://127.0.0.1:50743",
    mintHostCookie: async (force) => (force ? "dsh-auth-x=fresh" : "dsh-auth-x=stale"),
    send: (bytes) => sent.push(decodeFrame(bytes)),
    fetchImpl,
  });
  await gateway.onFrame(head(3));
  await gateway.onFrame({ type: FrameType.HTTP_REQUEST_END, streamId: 3, flags: 0, payload: new Uint8Array() });
  assert.equal(calls, 2);
  assert.deepEqual(cookies, ["dsh-auth-x=stale", "dsh-auth-x=fresh"]);
  assert.equal(JSON.parse(new TextDecoder().decode(sent[0]!.payload)).status, 200);
});

test("loopback 不可达时回 upstream-unreachable", async () => {
  const { gateway, sentFrames } = harness((async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch);
  await gateway.onFrame(head(4));
  await gateway.onFrame({ type: FrameType.HTTP_REQUEST_END, streamId: 4, flags: 0, payload: new Uint8Array() });
  const err = sentFrames.find((f) => f.type === FrameType.ERROR);
  assert.ok(err);
  assert.equal(JSON.parse(new TextDecoder().decode(err.payload)).code, "upstream-unreachable");
});

test("大响应体被切成不超过 64 KiB 的帧", async () => {
  const big = new Uint8Array(150_000);
  const { gateway, sentFrames } = harness(async () => new Response(big));
  await gateway.onFrame(head(5));
  await gateway.onFrame({ type: FrameType.HTTP_REQUEST_END, streamId: 5, flags: 0, payload: new Uint8Array() });
  const bodies = sentFrames.filter((f) => f.type === FrameType.HTTP_RESPONSE_BODY);
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every((f) => f.payload.byteLength <= 65536));
});

test("WS_OPEN 成功后回 ok", async () => {
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const socket: WsClientLike = {
    send: () => {},
    close: () => {},
    addEventListener(type, cb) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
  };
  const sent: Frame[] = [];
  const gateway = new Gateway({
    loopbackOrigin: "http://127.0.0.1:50743",
    mintHostCookie: async () => "dsh-auth-x=abc",
    send: (bytes) => sent.push(decodeFrame(bytes)),
    openSocket: () => socket,
  });
  await gateway.onFrame({
    type: FrameType.WS_OPEN,
    streamId: 7,
    flags: 0,
    payload: encodeJson({ path: "/api/remote.mux", headers: {} }),
  });
  await new Promise((r) => setTimeout(r, 10));
  for (const cb of listeners.get("open") ?? []) cb({});
  const ack = sent.find((f) => f.type === FrameType.WS_OPEN_ACK);
  assert.ok(ack);
  assert.equal(JSON.parse(new TextDecoder().decode(ack.payload)).ok, true);
});

test("WS 数据双向转发并带文本标志", async () => {
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const outbound: Uint8Array[] = [];
  const socket: WsClientLike = {
    send: (data) => outbound.push(data),
    close: () => {},
    addEventListener(type, cb) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
  };
  const sent: Frame[] = [];
  const gateway = new Gateway({
    loopbackOrigin: "http://127.0.0.1:50743",
    mintHostCookie: async () => "c=1",
    send: (bytes) => sent.push(decodeFrame(bytes)),
    openSocket: () => socket,
  });
  await gateway.onFrame({ type: FrameType.WS_OPEN, streamId: 8, flags: 0, payload: encodeJson({ path: "/api/remote.mux", headers: {} }) });
  await new Promise((r) => setTimeout(r, 10));

  await gateway.onFrame({ type: FrameType.WS_DATA, streamId: 8, flags: 1, payload: new TextEncoder().encode("ping") });
  assert.equal(new TextDecoder().decode(outbound[0]), "ping");

  for (const cb of listeners.get("message") ?? []) cb({ data: new TextEncoder().encode("pong") });
  const dataFrame = sent.find((f) => f.type === FrameType.WS_DATA);
  assert.equal(new TextDecoder().decode(dataFrame!.payload), "pong");
});
