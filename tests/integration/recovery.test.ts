import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTunnel } from "../../packages/plugin/src/agent.ts";
import type { FailureReason, SocketLike, TunnelStatus } from "../../packages/plugin/src/agent.ts";

interface FakeClock {
  now: number;
  pending: { at: number; fn: () => void }[];
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  advance(ms: number): void;
}

function clock(): FakeClock {
  const c: FakeClock = {
    now: 0,
    pending: [],
    setTimeout(fn, ms) {
      const entry = { at: c.now + ms, fn };
      c.pending.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      const index = c.pending.indexOf(handle as { at: number; fn: () => void });
      if (index >= 0) c.pending.splice(index, 1);
    },
    advance(ms) {
      const target = c.now + ms;
      for (;;) {
        const due = c.pending.filter((p) => p.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        c.pending.splice(c.pending.indexOf(due), 1);
        c.now = due.at;
        due.fn();
      }
      c.now = target;
    },
  };
  return c;
}

interface FakeSocket extends SocketLike {
  emit(event: string, payload?: unknown): void;
  closed: { code: number; reason: string } | null;
}

function sockets() {
  const created: FakeSocket[] = [];
  const create = (): FakeSocket => {
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const socket: FakeSocket = {
      closed: null,
      send: () => {},
      close: () => {},
      addEventListener(type, cb) {
        const arr = listeners.get(type) ?? [];
        arr.push(cb);
        listeners.set(type, arr);
      },
      emit(type, payload) {
        for (const cb of listeners.get(type) ?? []) cb(payload ?? {});
      },
    };
    created.push(socket);
    return socket;
  };
  return { create, created, last: () => created[created.length - 1]! };
}

function harness(random = 0.5) {
  const fake = clock();
  const socketsFactory = sockets();
  const statuses: { status: TunnelStatus; detail?: string }[] = [];
  const tunnel = new AgentTunnel(
    {
      url: "wss://relay.example/__dsh_agent",
      installId: "default",
      agentVersion: "0.0.0",
      dshVersion: "0.2.1-rc.5",
      capabilities: ["MUX"],
      onStatus: (status, detail) => statuses.push({ status, ...(detail ? { detail } : {}) }),
    },
    {
      createSocket: () => socketsFactory.create(),
      setTimeout: fake.setTimeout.bind(fake),
      clearTimeout: fake.clearTimeout.bind(fake),
      random: () => random,
    },
  );
  return { tunnel, fake, sockets: socketsFactory, statuses };
}

function open(h: ReturnType<typeof harness>): void {
  h.tunnel.start();
  h.sockets.last().emit("open", {});
}

test("网络中断后在首个退避窗口内重连", () => {
  const h = harness(0.5);
  open(h);
  assert.equal(h.sockets.created.length, 1);
  h.sockets.last().emit("close", { code: 1006, reason: "" });
  assert.equal(h.tunnel.status, "reconnecting");
  const retry = h.fake.pending[0];
  assert.ok(retry);
  const delay = retry.at - h.fake.now;
  assert.ok(delay >= 400 && delay <= 600, `重连延迟应在 500ms ±20% 内，实际 ${delay}ms`);
  h.fake.advance(delay);
  assert.equal(h.sockets.created.length, 2, "退避结束后应发起新连接");
});

test("中转重启（1001）同样自动重连", () => {
  const h = harness(0.5);
  open(h);
  h.sockets.last().emit("close", { code: 1001, reason: "restart" });
  assert.equal(h.tunnel.status, "reconnecting");
  h.fake.advance(600);
  assert.equal(h.sockets.created.length, 2);
});

test("连续失败按 500/1000/2000/5000 退避", () => {
  const h = harness(0.5);
  open(h);
  const delays: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    h.sockets.last().emit("close", { code: 1006 });
    const pending = h.fake.pending[0];
    assert.ok(pending);
    delays.push(pending.at - h.fake.now);
    h.fake.advance(pending.at - h.fake.now);
  }
  assert.deepEqual(delays, [500, 1_000, 2_000, 5_000]);
});

test("连接恢复后计数复位并清除失败原因", () => {
  const h = harness(0.5);
  open(h);
  h.sockets.last().emit("close", { code: 1006 });
  h.fake.advance(500);
  h.sockets.last().emit("open", {});
  assert.equal(h.tunnel.status, "connected");
  assert.equal(h.tunnel.failure, null);
});

test("凭证无效不重试，直接进入 failed", () => {
  const h = harness(0.5);
  open(h);
  h.sockets.last().emit("close", { code: 4401, reason: "unauthorized" });
  assert.equal(h.tunnel.status, "failed");
  assert.equal(h.tunnel.failure, "unauthorized");
  assert.equal(h.fake.pending.length, 0, "不应安排重连");
});

test("额度受限不重试", () => {
  const h = harness(0.5);
  open(h);
  h.sockets.last().emit("close", { code: 4402 });
  assert.equal(h.tunnel.status, "failed");
  assert.equal(h.tunnel.failure, "quota");
  assert.equal(h.fake.pending.length, 0);
});

test("版本不兼容按失败处理且不重连", () => {
  const h = harness(0.5);
  open(h);
  h.sockets.last().emit("close", { code: 4002 });
  assert.equal(h.tunnel.status, "failed");
  assert.equal(h.tunnel.failure, "protocol-version");
});

test("DNS 与证书失败被正确分类", () => {
  const dns = harness(0.5);
  open(dns);
  dns.sockets.last().emit("error", { message: "getaddrinfo ENOTFOUND relay.example" });
  dns.sockets.last().emit("close", { code: 1006, reason: "connect failed" });
  assert.equal(dns.tunnel.failure, "dns");

  const tls = harness(0.5);
  open(tls);
  tls.sockets.last().emit("error", { message: "self-signed certificate" });
  tls.sockets.last().emit("close", { code: 1006 });
  assert.equal(tls.tunnel.failure, "tls");
});

test("hello 超时归类为 hello-timeout", () => {
  const h = harness(0.5);
  open(h);
  h.sockets.last().emit("close", { code: 4001 });
  assert.equal(h.tunnel.failure as FailureReason, "hello-timeout");
});

test("停止后不再重连", () => {
  const h = harness(0.5);
  open(h);
  h.sockets.last().emit("close", { code: 1006 });
  h.tunnel.stop();
  h.fake.advance(10_000);
  assert.equal(h.sockets.created.length, 1);
});
