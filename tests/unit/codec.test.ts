import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  FrameType,
  ProtocolError,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  wsFragmentSizes,
} from "../../packages/protocol/src/index.ts";

test("编码后头字段位置与字节序正确", () => {
  const payload = new Uint8Array([1, 2, 3]);
  const buf = encodeFrame({ type: FrameType.PING, streamId: 0x01020304, flags: 0, payload });
  assert.equal(buf.byteLength, HEADER_BYTES + 3);
  const view = new DataView(buf.buffer);
  assert.equal(view.getUint8(0), PROTOCOL_VERSION);
  assert.equal(view.getUint8(1), FrameType.PING);
  assert.equal(view.getUint16(2, false), 0);
  assert.equal(view.getUint32(4, false), 0x01020304);
  assert.equal(view.getUint32(8, false), 3);
});

test("编解码往返保持 type/streamId/flags/payload", () => {
  const payload = encodeJson({ ok: true, n: 42 });
  const buf = encodeFrame({ type: FrameType.WS_DATA, streamId: 7, flags: 1, payload });
  const f = decodeFrame(buf);
  assert.equal(f.type, FrameType.WS_DATA);
  assert.equal(f.streamId, 7);
  assert.equal(f.flags, 1);
  assert.deepEqual(decodeJson(f.payload), { ok: true, n: 42 });
});

test("空载荷与控制帧可往返", () => {
  const f = decodeFrame(encodeFrame({ type: FrameType.PONG, streamId: 0, flags: 0, payload: new Uint8Array() }));
  assert.equal(f.type, FrameType.PONG);
  assert.equal(f.payload.byteLength, 0);
});

test("载荷超过单帧上限时编码即失败", () => {
  const payload = new Uint8Array(MAX_FRAME_BYTES + 1);
  assert.throws(
    () => encodeFrame({ type: FrameType.HTTP_REQUEST_BODY, streamId: 1, flags: 0, payload }),
    (e: unknown) => e instanceof ProtocolError && e.code === "bad-length",
  );
});

test("恰好等于上限的载荷可编码", () => {
  const payload = new Uint8Array(MAX_FRAME_BYTES);
  const f = decodeFrame(encodeFrame({ type: FrameType.HTTP_REQUEST_BODY, streamId: 1, flags: 0, payload }));
  assert.equal(f.payload.byteLength, MAX_FRAME_BYTES);
});

test("不足 12 字节的输入被拒", () => {
  assert.throws(
    () => decodeFrame(new Uint8Array(11)),
    (e: unknown) => e instanceof ProtocolError && e.code === "truncated",
  );
});

test("未知版本被拒", () => {
  const buf = encodeFrame({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() });
  buf[0] = 99;
  assert.throws(
    () => decodeFrame(buf),
    (e: unknown) => e instanceof ProtocolError && e.code === "bad-version",
  );
});

test("未知帧类型被拒", () => {
  const buf = encodeFrame({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() });
  buf[1] = 0xee;
  assert.throws(
    () => decodeFrame(buf),
    (e: unknown) => e instanceof ProtocolError && e.code === "unknown-type",
  );
});

test("声明长度大于实际剩余时被拒", () => {
  const buf = encodeFrame({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array([1, 2]) });
  new DataView(buf.buffer).setUint32(8, 10, false);
  assert.throws(
    () => decodeFrame(buf),
    (e: unknown) => e instanceof ProtocolError && e.code === "truncated",
  );
});

test("声明长度超过单帧上限时被拒", () => {
  const buf = encodeFrame({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() });
  new DataView(buf.buffer).setUint32(8, MAX_FRAME_BYTES + 1, false);
  assert.throws(
    () => decodeFrame(buf),
    (e: unknown) => e instanceof ProtocolError && e.code === "bad-length",
  );
});

test("带 byteOffset 的子数组中解析仍然正确", () => {
  const inner = encodeFrame({ type: FrameType.ERROR, streamId: 3, flags: 0, payload: encodeJson({ code: "protocol", message: "x" }) });
  const padded = new Uint8Array(inner.byteLength + 8);
  padded.set(inner, 8);
  const f = decodeFrame(padded.subarray(8));
  assert.equal(f.streamId, 3);
  assert.deepEqual(decodeJson(f.payload), { code: "protocol", message: "x" });
});

test("分片规划：按 64KB 切分，末片不超限", () => {
  assert.deepEqual(wsFragmentSizes(0), [0]);
  assert.deepEqual(wsFragmentSizes(100), [100]);
  const sizes = wsFragmentSizes(200_000);
  assert.equal(sizes.length, 4);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 200_000);
  assert.ok(sizes.every((n) => n <= MAX_FRAME_BYTES));
});
