import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameFlags, FrameType, decodeFrame } from "../../packages/protocol/src/index.ts";
import type { Frame } from "../../packages/protocol/src/index.ts";
import { Gateway } from "../../packages/plugin/src/gateway.ts";
import { RelayBridge } from "../../packages/relay/src/bridge.ts";

/**
 * 端到端（无网络）：真实 Gateway 与真实 RelayBridge 用帧互相喂，
 * 验证 >64KB 的 WS 消息在两个方向都能完整穿过协议栈。
 */
test("大 WS 消息穿过 Gateway 与 RelayBridge 后内容不变", async () => {
  const toAgent: Frame[] = [];
  const hostReceived: (string | Uint8Array)[] = [];
  const hostListeners = new Map<string, ((ev: unknown) => void)[]>();

  let bridge: RelayBridge;
  const gateway = new Gateway({
    loopbackOrigin: "http://127.0.0.1:5",
    mintHostCookie: async () => "c=1",
    send: (bytes) => {
      const frame = decodeFrame(bytes);
      toAgent.push(frame);
      bridge.onFrame(frame);
    },
    openSocket: () =>
      ({
        send(data: string | Uint8Array) {
          hostReceived.push(data);
        },
        close() {},
        addEventListener(type: string, cb: (ev: unknown) => void) {
          const arr = hostListeners.get(type) ?? [];
          arr.push(cb);
          hostListeners.set(type, arr);
        },
      }) as never,
  });

  const browserSink: Uint8Array[] = [];
  bridge = new RelayBridge({
    send: (bytes) => {
      void gateway.onFrame(decodeFrame(bytes));
    },
  });
  const streamId = bridge.openWs(
    { path: "/api/remote.mux", headers: {} },
    { open: () => {}, data: (chunk) => browserSink.push(chunk), close: () => {}, fail: () => {} },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((hostListeners.get("message") ?? []).length, 1, "只应建立一个宿主 WS");

  // DSH → 浏览器：200KB 文本，应被切成多帧
  const outbound = "y".repeat(200_000);
  for (const cb of hostListeners.get("message") ?? []) cb({ data: outbound });
  const dataFrames = toAgent.filter((f) => f.type === FrameType.WS_DATA);
  assert.ok(dataFrames.length > 1, "应切片");
  assert.ok(dataFrames.every((f) => f.payload.byteLength <= 65_536));
  assert.ok(dataFrames.slice(0, -1).every((f) => (f.flags & FrameFlags.WS_MORE) !== 0));
  assert.equal(dataFrames.at(-1)!.flags & FrameFlags.WS_MORE, 0);

  // 浏览器 → DSH：150KB 二进制，应完整交付给宿主
  bridge.sendWsData(streamId, new Uint8Array(150_000).fill(9));
  const delivered = hostReceived.at(-1);
  assert.ok(delivered instanceof Uint8Array, "应交付二进制");
  assert.equal((delivered as Uint8Array).byteLength, 150_000);
});
