import {
  FrameType,
  PROTOCOL_VERSION,
  HELLO_TIMEOUT_MS,
  CLOSE_CODES,
  decodeFrame,
  encodeFrame,
  encodeJson,
} from "../../protocol/src/index.ts";
import type { AgentHello, ErrorCode, Frame, HttpResponseHead, RelayHelloAck } from "../../protocol/src/index.ts";
import { RelayBridge } from "./bridge.ts";
import { errorResponse } from "./errors.ts";

interface PendingHead {
  resolve(head: HttpResponseHead): void;
  reject(code: ErrorCode): void;
}

/**
 * 每个安装一个实例：持有 agent 的隧道连接，并把浏览器请求复用到该连接上。
 * 运行时由 workerd 提供 WebSocketPair / Request / Response。
 */
/** 升级请求可能被上游 sanitize 或 Cloudflare 剥掉 hop-by-hop 头，因此多信号判断 */
function isUpgradeRequest(request: Request): boolean {
  return (
    request.headers.get("x-dsh-upgrade") === "1" ||
    request.headers.get("sec-websocket-key") !== null ||
    (request.headers.get("connection") ?? "").toLowerCase().includes("upgrade") ||
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  );
}

export const AGENT_PATH = "/__dsh_agent";

/**
 * 接收 server 端 socket。
 * 注意：不能与 hibernation 的 acceptWebSocket 混用——一旦 acceptWebSocket，
 * 消息只会进 webSocketMessage()，addEventListener("message") 收不到任何东西（实测握手静默失败）。
 */
function acceptSocket(socket: WebSocket): void {
  (socket as unknown as { accept(): void }).accept();
}

export class RelayObject {
  readonly #state: DurableObjectState;
  #agent: WebSocket | null = null;
  #bridge: RelayBridge | null = null;

  constructor(state: DurableObjectState, _env: unknown) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    // 升级请求按原样转交时没有标记头，用路径判定 agent 通道
    const isAgent =
      request.headers.get("x-dsh-agent") === "1" ||
      new URL(request.url).pathname === AGENT_PATH;
    if (isAgent) return this.#handleAgent(request);
    if (isUpgradeRequest(request)) {
      return this.#handleBrowserWs(request);
    }
    return this.#handleBrowser(request);
  }

  /** 浏览器侧的 WS 透传：与 agent 的 /api/remote.mux 一一对应 */
  #handleBrowserWs(request: Request): Response {
    const bridge = this.#bridge;
    if (!bridge) return errorResponse("agent-not-connected");

    const pair = new WebSocketPair();
    const client = pair[0] as WebSocket;
    const server = pair[1] as WebSocket;
    acceptSocket(server);

    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });

    const url = new URL(request.url);
    const streamId = bridge.openWs(
      { path: url.pathname + url.search, headers },
      {
        open: () => {},
        data: (chunk, isText) => server.send(isText ? new TextDecoder().decode(chunk) : chunk),
        close: (code, reason) => server.close(code, reason),
        fail: () => server.close(1011, "upstream failure"),
      },
    );

    server.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
      bridge.sendWsData(streamId, bytes, typeof data === "string");
    });
    server.addEventListener("close", (event: unknown) => {
      const ev = event as { code?: number; reason?: string };
      bridge.closeWs(streamId, ev.code ?? 1000, ev.reason ?? "");
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  #handleAgent(request: Request): Response {
    if (!isUpgradeRequest(request)) {
      return errorResponse("protocol");
    }
    // 同一个安装重复连接时"后到者接管"：旧连接可能已经半死（客户端进程被杀、
    // 网络中断但 DO 还没收到 close），此时返回 409 会让这台电脑永久连不上。
    if (this.#agent) {
      const stale = this.#agent;
      this.#agent = null;
      this.#bridge?.dispose();
      this.#bridge = null;
      try {
        stale.close(CLOSE_CODES.agentAlreadyConnected, "replaced by a newer connection");
      } catch {
        // 旧 socket 已经不可用：忽略
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0] as WebSocket;
    const server = pair[1] as WebSocket;
    acceptSocket(server);
    this.#agent = server;

    let helloSeen = false;
    const helloTimer = setTimeout(() => {
      if (!helloSeen) server.close(CLOSE_CODES.helloTimeout, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    server.addEventListener("message", (event: MessageEvent) => {
      const data = typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data as ArrayBuffer);
      let frame: Frame;
      try {
        frame = decodeFrame(data);
      } catch {
        server.send(encodeFrame({ type: FrameType.ERROR, streamId: 0, flags: 0, payload: encodeJson({ code: "protocol", message: "帧解析失败" }) }));
        server.close(CLOSE_CODES.protocolError, "protocol error");
        return;
      }

      if (!helloSeen) {
        if (frame.type !== FrameType.AGENT_HELLO) {
          server.close(CLOSE_CODES.protocolError, "expect AGENT_HELLO");
          return;
        }
        const hello = JSON.parse(new TextDecoder().decode(frame.payload)) as AgentHello;
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          server.send(encodeFrame({ type: FrameType.ERROR, streamId: 0, flags: 0, payload: encodeJson({ code: "protocol-version", message: "版本不兼容" }) }));
          server.close(CLOSE_CODES.protocolVersion, "protocol version");
          return;
        }
        helloSeen = true;
        clearTimeout(helloTimer);
        const ack: RelayHelloAck = {
          protocolVersion: PROTOCOL_VERSION,
          relayOrigin: new URL(request.url).origin,
        };
        server.send(encodeFrame({ type: FrameType.RELAY_HELLO_ACK, streamId: 0, flags: 0, payload: encodeJson(ack) }));
        this.#bridge = new RelayBridge({
          send: (bytes) => server.send(bytes),
          close: (code, reason) => server.close(code, reason),
        });
        return;
      }

      const accepted = this.#bridge?.onFrame(frame) ?? false;
      if (!accepted) server.close(CLOSE_CODES.protocolError, "unexpected frame");
    });

    const cleanup = () => {
      clearTimeout(helloTimer);
      this.#bridge?.dispose();
      this.#bridge = null;
      this.#agent = null;
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  async #handleBrowser(request: Request): Promise<Response> {
    const bridge = this.#bridge;
    if (!bridge) return errorResponse("agent-not-connected");

    const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    let settleHead: ((head: HttpResponseHead) => void) | null = null;
    let settleFail: ((code: ErrorCode) => void) | null = null;
    const headPromise = new Promise<HttpResponseHead>((resolve) => {
      settleHead = resolve;
    });
    const failPromise = new Promise<never>((_, reject) => {
      settleFail = (code) => reject(new Error(code));
    });

    bridge.request(
      { method: request.method, path: new URL(request.url).pathname + new URL(request.url).search, headers },
      body,
      {
        head: (status, responseHeaders) => settleHead?.({ status, headers: responseHeaders }),
        body: (chunk) => {
          void writer.write(chunk);
        },
        end: () => {
          void writer.close();
        },
        fail: (code) => settleFail?.(code),
      },
    );

    try {
      const head = await Promise.race([headPromise, failPromise]);
      return new Response(readable, { status: head.status, headers: head.headers });
    } catch (err) {
      const code = (err as Error).message as ErrorCode;
      void writer.abort();
      return errorResponse(code);
    }
  }
}
