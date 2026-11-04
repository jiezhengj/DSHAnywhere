import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayBridge } from "../../packages/relay/src/bridge.ts";
import type { HttpSink } from "../../packages/relay/src/bridge.ts";
import { FrameType, decodeFrame, encodeFrame, encodeJson } from "../../packages/protocol/src/index.ts";
import type { Frame } from "../../packages/protocol/src/index.ts";

function harness() {
  const sent: Frame[] = [];
  const transport = { send: (f: Uint8Array) => sent.push(decodeFrame(f)), close: () => {} };
  const events: string[] = [];
  const chunks: Uint8Array[] = [];
  const sink: HttpSink = {
    head: (status, headers) => events.push(`head:${status}:${headers["content-type"] ?? ""}`),
    body: (chunk) => {
      chunks.push(chunk);
      events.push(`body:${chunk.byteLength}`);
    },
    end: () => events.push("end"),
    fail: (code) => events.push(`fail:${code}`),
  };
  return { sent, transport, sink, events, chunks };
}

test("一次请求按 HEAD→BODY…→END 发出", () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport);
  const body = new Uint8Array(3);
  bridge.request({ method: "GET", path: "/", headers: {} }, body, h.sink);
  assert.deepEqual(h.sent.map((f) => f.type), [FrameType.HTTP_REQUEST_HEAD, FrameType.HTTP_REQUEST_BODY, FrameType.HTTP_REQUEST_END]);
});

test("超过单帧上限的请求体被分片", () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport);
  bridge.request({ method: "POST", path: "/", headers: {} }, new Uint8Array(70000), h.sink);
  const bodies = h.sent.filter((f) => f.type === FrameType.HTTP_REQUEST_BODY);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.payload.byteLength, 65536);
  assert.equal(bodies[1]?.payload.byteLength, 4464);
});

test("响应帧被还原成 head/body/end", () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport);
  const id = bridge.request({ method: "GET", path: "/", headers: {} }, null, h.sink);
  bridge.onFrame({ type: FrameType.HTTP_RESPONSE_HEAD, streamId: id, flags: 0, payload: encodeJson({ status: 200, headers: { "content-type": "text/html" } }) });
  bridge.onFrame({ type: FrameType.HTTP_RESPONSE_BODY, streamId: id, flags: 0, payload: new Uint8Array([1, 2]) });
  bridge.onFrame({ type: FrameType.HTTP_RESPONSE_END, streamId: id, flags: 0, payload: new Uint8Array() });
  assert.deepEqual(h.events, ["head:200:text/html", "body:2", "end"]);
  assert.equal(bridge.openStreams, 0);
});

test("错误帧转成 sink.fail", () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport);
  const id = bridge.request({ method: "GET", path: "/", headers: {} }, null, h.sink);
  bridge.onFrame({ type: FrameType.ERROR, streamId: id, flags: 0, payload: encodeJson({ code: "agent-not-connected", message: "x" }) });
  assert.deepEqual(h.events, ["fail:agent-not-connected"]);
});

test("窗口消耗过半后回发 FLOW_CREDIT", () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport, { windowBytes: 1000 });
  const id = bridge.request({ method: "GET", path: "/", headers: {} }, null, h.sink);
  bridge.onFrame({ type: FrameType.HTTP_RESPONSE_BODY, streamId: id, flags: 0, payload: new Uint8Array(600) });
  const credit = h.sent.find((f) => f.type === FrameType.FLOW_CREDIT);
  assert.ok(credit);
  assert.equal(JSON.parse(new TextDecoder().decode(credit.payload)).bytes, 600);
});

test("PING 自动回 PONG", () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport);
  bridge.onFrame({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() });
  assert.equal(h.sent.at(-1)?.type, FrameType.PONG);
});

test("未知帧类型被拒绝", () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport);
  assert.equal(bridge.onFrame({ type: FrameType.WS_OPEN, streamId: 1, flags: 0, payload: new Uint8Array() }), false);
});

test("dispose 让在途请求失败", () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport);
  bridge.request({ method: "GET", path: "/", headers: {} }, null, h.sink);
  bridge.dispose();
  assert.deepEqual(h.events, ["fail:stream-aborted"]);
  assert.equal(bridge.openStreams, 0);
});

test("超时后回 504 类错误", async () => {
  const h = harness();
  const bridge = new RelayBridge(h.transport, { timeoutMs: 10 });
  bridge.request({ method: "GET", path: "/", headers: {} }, null, h.sink);
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(h.events, ["fail:upstream-timeout"]);
});

test("大 WS 消息经 bridge 分片传输与还原", () => {
  const out: Frame[] = [];
  const bridge = new RelayBridge({ send: (bytes) => out.push(decodeFrame(bytes)) });
  const got: { data: Uint8Array; text: boolean }[] = [];
  const id = bridge.openWs({ path: "/api/remote.mux", headers: {} }, {
    open: () => {},
    data: (chunk, isText) => got.push({ data: chunk, text: isText }),
    close: () => {},
    fail: () => {},
  });
  bridge.sendWsData(id, new Uint8Array(150_000).fill(7), true);
  const frames = out.filter((f) => f.type === FrameType.WS_DATA);
  assert.ok(frames.length > 1);
  for (const f of frames) bridge.onFrame(f);
  assert.equal(got.length, 1, "应合并回一条消息");
  assert.equal(got[0]!.data.byteLength, 150_000);
  assert.equal(got[0]!.text, true);
});
