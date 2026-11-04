import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayBridge } from "../../packages/relay/src/bridge.ts";
import type { WsSink } from "../../packages/relay/src/bridge.ts";
import { FrameFlags, FrameType, decodeFrame, encodeJson } from "../../packages/protocol/src/index.ts";
import type { Frame } from "../../packages/protocol/src/index.ts";

function harness() {
  const sent: Frame[] = [];
  const events: string[] = [];
  const sink: WsSink = {
    open: () => events.push("open"),
    data: (chunk, isText) => events.push(`data:${new TextDecoder().decode(chunk)}:${isText}`),
    close: (code) => events.push(`close:${code}`),
    fail: (code) => events.push(`fail:${code}`),
  };
  const bridge = new RelayBridge({ send: (f: Uint8Array) => sent.push(decodeFrame(f)), close: () => {} });
  return { bridge, sent, sink, events };
}

test("openWs 发出 WS_OPEN 帧", () => {
  const h = harness();
  const id = h.bridge.openWs({ path: "/api/remote.mux?x=1", headers: { a: "b" } }, h.sink);
  const frame = h.sent.find((f) => f.type === FrameType.WS_OPEN);
  assert.ok(frame);
  assert.equal(JSON.parse(new TextDecoder().decode(frame.payload)).path, "/api/remote.mux?x=1");
  assert.ok(id > 0);
});

test("WS_OPEN_ACK ok 触发 sink.open", () => {
  const h = harness();
  const id = h.bridge.openWs({ path: "/api/remote.mux", headers: {} }, h.sink);
  h.bridge.onFrame({ type: FrameType.WS_OPEN_ACK, streamId: id, flags: 0, payload: encodeJson({ ok: true }) });
  assert.deepEqual(h.events, ["open"]);
});

test("WS_OPEN_ACK 失败触发 sink.fail 并清理", () => {
  const h = harness();
  const id = h.bridge.openWs({ path: "/api/remote.mux", headers: {} }, h.sink);
  h.bridge.onFrame({ type: FrameType.WS_OPEN_ACK, streamId: id, flags: 0, payload: encodeJson({ ok: false, reason: "upstream-unreachable" }) });
  assert.deepEqual(h.events, ["fail:upstream-unreachable"]);
});

test("WS_DATA 文本标志被还原", () => {
  const h = harness();
  const id = h.bridge.openWs({ path: "/api/remote.mux", headers: {} }, h.sink);
  h.bridge.onFrame({ type: FrameType.WS_DATA, streamId: id, flags: FrameFlags.WS_TEXT, payload: new TextEncoder().encode("hi") });
  h.bridge.onFrame({ type: FrameType.WS_DATA, streamId: id, flags: 0, payload: new Uint8Array([1]) });
  assert.deepEqual(h.events, ["data:hi:true", "data:\u0001:false"]);
});

test("WS_CLOSE 触发 sink.close", () => {
  const h = harness();
  const id = h.bridge.openWs({ path: "/api/remote.mux", headers: {} }, h.sink);
  h.bridge.onFrame({ type: FrameType.WS_CLOSE, streamId: id, flags: 0, payload: encodeJson({ code: 1001, reason: "bye" }) });
  assert.deepEqual(h.events, ["close:1001"]);
});

test("sendWsData/closeWs 发出对应帧", () => {
  const h = harness();
  const id = h.bridge.openWs({ path: "/api/remote.mux", headers: {} }, h.sink);
  h.bridge.sendWsData(id, new TextEncoder().encode("x"), true);
  h.bridge.closeWs(id, 1000, "done");
  const data = h.sent.find((f) => f.type === FrameType.WS_DATA);
  assert.equal(data?.flags & FrameFlags.WS_TEXT, FrameFlags.WS_TEXT);
  assert.ok(h.sent.find((f) => f.type === FrameType.WS_CLOSE));
});

test("dispose 让在途 WS 失败", () => {
  const h = harness();
  h.bridge.openWs({ path: "/api/remote.mux", headers: {} }, h.sink);
  h.bridge.dispose();
  assert.deepEqual(h.events, ["fail:stream-aborted"]);
});
