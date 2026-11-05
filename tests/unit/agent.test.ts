import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTunnel } from "../../packages/plugin/src/agent.ts";
import type { SocketLike, TunnelStatus } from "../../packages/plugin/src/agent.ts";
import { FrameType, decodeFrame, encodeFrame, encodeJson } from "../../packages/protocol/src/index.ts";
import type { Frame } from "../../packages/protocol/src/index.ts";

function fakeClock() {
  let now = 0;
  const queue: { at: number; fn: () => void; id: number }[] = [];
  let id = 1;
  return {
    setTimeout(fn: () => void, ms: number) {
      const entry = { at: now + ms, fn, id: id++ };
      queue.push(entry);
      return entry.id;
    },
    clearTimeout(handle: unknown) {
      const i = queue.findIndex((e) => e.id === handle);
      if (i >= 0) queue.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const entry of [...queue].sort((a, b) => a.at - b.at)) {
        if (entry.at <= now) {
          queue.splice(queue.indexOf(entry), 1);
          entry.fn();
        }
      }
    },
    get pending() {
      return queue.length;
    },
    get time() {
      return now;
    },
  };
}

function fakeSocket() {
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const sent: Frame[] = [];
  const socket: SocketLike & { fire(type: string, ev?: unknown): void; sentFrames: Frame[]; closed: unknown } = {
    sentFrames: sent,
    closed: null,
    send(data) {
      sent.push(decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data)));
    },
    close(code, reason) {
      socket.closed = { code, reason };
      socket.fire("close", { code, reason });
    },
    addEventListener(type, cb) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    fire(type, ev) {
      for (const cb of listeners.get(type) ?? []) cb(ev);
    },
  };
  return socket;
}

function harness(overrides: Partial<{ random: () => number; onHelloAck: (ack: { relayOrigin: string }) => void }> = {}) {
  const clock = fakeClock();
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const statuses: TunnelStatus[] = [];
  const frames: Frame[] = [];
  const tunnel = new AgentTunnel(
    {
      url: "wss://relay.example/__dsh_agent?install=inst",
      installId: "inst",
      agentVersion: "0.0.0",
      dshVersion: "0.2.1",
      capabilities: ["MUX"],
      onFrame: (f) => frames.push(f),
      onStatus: (s) => statuses.push(s),
      ...(overrides.onHelloAck ? { onHelloAck: overrides.onHelloAck } : {}),
    },
    {
      now: () => clock.time,
      createSocket: () => {
        const s = fakeSocket();
        sockets.push(s);
        return s;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: overrides.random ?? (() => 0.5),
    },
  );
  return { tunnel, clock, sockets, statuses, frames };
}

test("连接建立后首帧是 AGENT_HELLO", () => {
  const h = harness();
  h.tunnel.start();
  const socket = h.sockets[0]!;
  socket.fire("open");
  assert.equal(socket.sentFrames[0]?.type, FrameType.AGENT_HELLO);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(socket.sentFrames[0]!.payload)).installId, "inst");
});

test("连接后状态变为 connected", () => {
  const h = harness();
  h.tunnel.start();
  h.sockets[0]!.fire("open");
  assert.equal(h.tunnel.status, "connected");
  assert.ok(h.statuses.includes("connected"));
});

test("HELLO_ACK 回调 relayOrigin", () => {
  let origin = "";
  const h = harness({ onHelloAck: (ack) => (origin = ack.relayOrigin) });
  h.tunnel.start();
  const socket = h.sockets[0]!;
  socket.fire("open");
  socket.fire("message", {
    data: encodeFrame({
      type: FrameType.RELAY_HELLO_ACK,
      streamId: 0,
      flags: 0,
      payload: encodeJson({ protocolVersion: 1, relayOrigin: "https://r.example" }),
    }),
  });
  assert.equal(origin, "https://r.example");
});

test("心跳按 5 秒发送 PING", () => {
  const h = harness();
  h.tunnel.start();
  const socket = h.sockets[0]!;
  socket.fire("open");
  const before = socket.sentFrames.filter((f) => f.type === FrameType.PING).length;
  h.clock.advance(5_000);
  assert.equal(socket.sentFrames.filter((f) => f.type === FrameType.PING).length, before + 1);
});

test("收到 PING 立即回 PONG", () => {
  const h = harness();
  h.tunnel.start();
  const socket = h.sockets[0]!;
  socket.fire("open");
  socket.fire("message", { data: encodeFrame({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() }) });
  assert.equal(socket.sentFrames.at(-1)?.type, FrameType.PONG);
});

test("意外断开后按退避重连并新建连接", () => {
  const h = harness();
  h.tunnel.start();
  h.sockets[0]!.fire("open");
  h.sockets[0]!.fire("close", { code: 1006 });
  assert.equal(h.tunnel.status, "reconnecting");
  h.clock.advance(600);
  assert.equal(h.sockets.length, 2);
});

test("4002 版本不兼容不再重连", () => {
  const h = harness();
  h.tunnel.start();
  h.sockets[0]!.fire("open");
  h.sockets[0]!.fire("close", { code: 4002 });
  assert.equal(h.tunnel.status, "failed");
  h.clock.advance(60_000);
  assert.equal(h.sockets.length, 1);
});

test("4003 被新连接顶掉后先重试抢回", () => {
  const h = harness();
  h.tunnel.start();
  h.sockets[0]!.fire("open");
  h.sockets[0]!.fire("close", { code: 4003 });
  assert.equal(h.tunnel.status, "reconnecting");
  h.clock.advance(60_000);
  assert.equal(h.sockets.length, 2);
});

test("连续被顶掉超过上限后停止重试，避免新旧实例互相打架", () => {
  const h = harness();
  h.tunnel.start();
  // 最多抢回 2 次：第 3 次再被顶掉就停在 failed，等用户手动重连
  for (let i = 0; i < 3; i += 1) {
    h.sockets[h.sockets.length - 1]!.fire("open");
    h.sockets[h.sockets.length - 1]!.fire("close", { code: 4003 });
    h.clock.advance(60_000);
  }
  assert.equal(h.tunnel.status, "failed");
  assert.equal(h.sockets.length, 3);
});

test("心跳收不到任何帧时判定链路已死并重连", () => {
  const h = harness();
  h.tunnel.start();
  h.sockets[0]!.fire("open");
  // 三拍心跳都没收到任何帧（PONG 也没有）→ 认为半开连接，主动关闭并重连
  h.clock.advance(80_000);
  assert.deepEqual(h.sockets[0]!.closed, { code: 1011, reason: "heartbeat timeout" });
  h.clock.advance(60_000);
  assert.equal(h.sockets.length, 2, "应当已经重连");
});

test("stop 后不再重连", () => {
  const h = harness();
  h.tunnel.start();
  h.sockets[0]!.fire("open");
  h.tunnel.stop();
  h.clock.advance(60_000);
  assert.equal(h.sockets.length, 1);
});

test("未连接时 send 返回 false 而不抛错", () => {
  const h = harness();
  assert.equal(h.tunnel.send({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() }), false);
});

test("发送瞬间连接被关闭时不抛异常", () => {
  const h = harness();
  h.tunnel.start();
  const socket = h.sockets[0]!;
  socket.fire("open");
  socket.send = () => {
    throw new Error("Sent before connected.");
  };
  assert.equal(h.tunnel.send({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() }), false);
});

test("二进制帧以 Blob 交付时也能解析", async () => {
  let origin = "";
  const h = harness({ onHelloAck: (ack) => (origin = ack.relayOrigin) });
  h.tunnel.start();
  const socket = h.sockets[0]!;
  socket.fire("open");
  const ack = encodeFrame({
    type: FrameType.RELAY_HELLO_ACK,
    streamId: 0,
    flags: 0,
    payload: encodeJson({ protocolVersion: 1, relayOrigin: "https://blob.example" }),
  });
  socket.fire("message", { data: new Blob([ack as unknown as BlobPart]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(origin, "https://blob.example", "Blob 帧应被解析出 ACK");
});

test("坏帧导致连接关闭", () => {
  const h = harness();
  h.tunnel.start();
  const socket = h.sockets[0]!;
  socket.fire("open");
  socket.fire("message", { data: new Uint8Array(3) });
  assert.equal(socket.closed !== null, true);
});
