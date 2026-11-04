// 真实链路压测/采样用的 agent 侧装配（不随插件发布）。
// 用途：连上真实 Cloudflare 中转，把 loopback DSH 暴露出去，并统计每流的字节数。
// 用法：node scripts/bench-agent.mjs <relayOrigin> <loopbackOrigin> <tokenPath>
import { Gateway } from "../packages/plugin/src/gateway.ts";
import { AgentTunnel } from "../packages/plugin/src/agent.ts";
import { decodeFrame, FrameType } from "../packages/protocol/src/index.ts";

const [relayOrigin, loopbackOrigin, tokenPath] = process.argv.slice(2);
if (!relayOrigin || !loopbackOrigin || !tokenPath) {
  console.error("用法: node scripts/bench-agent.mjs <relayOrigin> <loopbackOrigin> <tokenPath>");
  process.exit(2);
}

// 1) 用一次性 token 换 DSH 会话 cookie（与插件 adapter 里的 authenticatedUrl 等价）
const tokenUrl = new URL(tokenPath, loopbackOrigin).toString();
const authRes = await fetch(tokenUrl, { redirect: "manual" });
const setCookie = authRes.headers.getSetCookie?.() ?? [];
const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
if (!cookie) {
  console.error("未能取得宿主 cookie，status=", authRes.status);
  process.exit(3);
}

const t0 = Date.now();
const streams = new Map();
const stats = { requests: 0, bytesDown: 0, framesDown: 0, bytesUp: 0, framesUp: 0, wsStreams: 0, wsBytes: 0 };

let tunnel;
const gateway = new Gateway({
  loopbackOrigin,
  openSocket: (target, headers) => {
    console.error("[bench] WS 打开", target, "cookie?", Boolean(headers.cookie));
    const ws = new WebSocket(target, { headers });
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => console.error("[bench] WS 打开成功"));
    ws.addEventListener("close", (e) => console.error("[bench] WS 关闭", e.code, e.reason));
    ws.addEventListener("error", (e) => console.error("[bench] WS 错误", e?.message ?? ""));
    return ws;
  },
  mintHostCookie: async () => cookie,
  authorize: () => "ok",
  send: (bytes) => {
    stats.framesUp += 1;
    stats.bytesUp += bytes.byteLength;
    tunnel?.send(bytes);
  },
});

tunnel = new AgentTunnel(
  {
    url: `${relayOrigin.replace(/^http/, "ws")}/__dsh_agent`,
    installId: process.env.BENCH_INSTALL_ID ?? "default",
    agentVersion: "bench",
    dshVersion: "0.2.1-rc.5",
    capabilities: ["MUX"],
    onStatus: (status, detail) => console.error(`[bench] 隧道状态 ${status}${detail ? ` (${detail})` : ""}`),
    onHelloAck: (ack) => console.error(`[bench] 握手完成 relayOrigin=${ack.relayOrigin}`),
    onFrame: (frame) => {
      stats.framesDown += 1;
      stats.bytesDown += frame.payload.byteLength + 12;
      const entry = streams.get(frame.streamId) ?? { path: "?", method: "?", bytes: 0, status: 0 };
      if (frame.type === FrameType.HTTP_RESPONSE_HEAD) {
        const head = JSON.parse(new TextDecoder().decode(frame.payload));
        entry.status = head.status;
        streams.set(frame.streamId, entry);
        stats.requests += 1;
      } else if (frame.type === FrameType.HTTP_RESPONSE_BODY) {
        entry.bytes += frame.payload.byteLength;
        streams.set(frame.streamId, entry);
      } else if (frame.type === FrameType.WS_OPEN_ACK || frame.type === FrameType.WS_DATA) {
        if (!streams.has(frame.streamId)) stats.wsStreams += 1;
        stats.wsBytes += frame.payload.byteLength;
        streams.set(frame.streamId, { path: "/api/remote.mux", method: "WS", bytes: 0, status: 101 });
      }
      void gateway.onFrame(frame);
    },
  },
  { createSocket: (url) => new WebSocket(url) },
);

// 记录上行请求路径，便于按路径归因
const originalOnFrame = gateway.onFrame.bind(gateway);
gateway.onFrame = async (frame) => {
  if (frame.type === FrameType.HTTP_REQUEST_HEAD) {
    const head = JSON.parse(new TextDecoder().decode(frame.payload));
    streams.set(frame.streamId, { path: head.path, method: head.method, bytes: 0, status: 0 });
  }
  return originalOnFrame(frame);
};

tunnel.start();

function report() {
  const perStream = [...streams.values()].filter((s) => s.bytes > 0 || s.status > 0);
  const sizes = perStream.map((s) => s.bytes).sort((a, b) => a - b);
  const pct = (p) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] ?? 0;
  console.log(
    JSON.stringify(
      {
        uptimeSec: Math.round((Date.now() - t0) / 1000),
        requests: stats.requests,
        responseBytes: stats.bytesDown,
        responseKB: Math.round(stats.bytesDown / 1024),
        medianResponseBytes: pct(0.5),
        p95ResponseBytes: pct(0.95),
        maxResponseBytes: sizes.at(-1) ?? 0,
        framesDown: stats.framesDown,
        framesUp: stats.framesUp,
        wsStreams: stats.wsStreams,
        wsBytes: stats.wsBytes,
        topPaths: perStream
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 8)
          .map((s) => `${s.method} ${s.path} ${s.status} ${s.bytes}B`),
      },
      null,
      2,
    ),
  );
}

process.on("SIGUSR2", report);
process.on("SIGINT", () => {
  report();
  tunnel.stop();
  process.exit(0);
});
console.error("[bench] 已启动，发送 SIGUSR2 打印统计，SIGINT 结束");
