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
export class RelayObject {
  readonly #state: DurableObjectState;
  #agent: WebSocket | null = null;
  #bridge: RelayBridge | null = null;

  constructor(state: DurableObjectState, _env: unknown) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const isAgent = request.headers.get("x-dsh-agent") === "1";
    return isAgent ? this.#handleAgent(request) : this.#handleBrowser(request);
  }

  #handleAgent(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse("protocol");
    }
    if (this.#agent) {
      return errorResponse("agent-already-connected");
    }

    const pair = new WebSocketPair();
    const client = pair[0] as WebSocket;
    const server = pair[1] as WebSocket;
    this.#state.acceptWebSocket?.(server);
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
