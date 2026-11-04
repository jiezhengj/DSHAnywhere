import {
  FrameType,
  MAX_FRAME_BYTES,
  decodeJson,
  encodeFrame,
  encodeJson,
} from "../../protocol/src/index.ts";
import type {
  ErrorCode,
  Frame,
  HttpRequestHead,
  HttpResponseHead,
  WsClose,
  WsOpen,
} from "../../protocol/src/index.ts";
import { FlowWindow, splitPayload } from "./flow.ts";
import { filterResponseHeaders, rewriteRequestHeaders, toAbsoluteUrl } from "./rewrite.ts";

export interface WsClientLike {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (event: unknown) => void): void;
  binaryType?: string;
}

export interface GatewayDeps {
  loopbackOrigin: string;
  mintHostCookie: (force?: boolean) => Promise<string>;
  send: (bytes: Uint8Array) => void;
  fetchImpl?: typeof fetch;
  openSocket?: (url: string, headers: Record<string, string>) => WsClientLike;
  maxFrameBytes?: number;
}

interface PendingRequest {
  head: HttpRequestHead;
  chunks: Uint8Array[];
  bytes: number;
}

const MAX_REQUEST_BODY = 25 * 1024 * 1024;

/**
 * 插件侧网关：把中转发来的帧还原成对 loopback 的 HTTP/WS 请求，
 * 再把响应切帧回送。对 DSH 而言这只是一个普通的本地请求。
 */
export class Gateway {
  readonly #deps: GatewayDeps;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #windows = new Map<number, FlowWindow>();
  readonly #creditWaiters = new Map<number, () => void>();
  readonly #sockets = new Map<number, WsClientLike>();

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
  }

  async onFrame(frame: Frame): Promise<void> {
    switch (frame.type) {
      case FrameType.HTTP_REQUEST_HEAD:
        this.#pending.set(frame.streamId, {
          head: decodeJson<HttpRequestHead>(frame.payload),
          chunks: [],
          bytes: 0,
        });
        return;
      case FrameType.HTTP_REQUEST_BODY: {
        const pending = this.#pending.get(frame.streamId);
        if (!pending) return;
        pending.chunks.push(frame.payload);
        pending.bytes += frame.payload.byteLength;
        if (pending.bytes > MAX_REQUEST_BODY) {
          this.#pending.delete(frame.streamId);
          this.#error(frame.streamId, "backpressure");
        }
        return;
      }
      case FrameType.HTTP_REQUEST_END:
        await this.#performRequest(frame.streamId);
        return;
      case FrameType.WS_OPEN:
        this.#openSocket(frame.streamId, decodeJson<WsOpen>(frame.payload));
        return;
      case FrameType.WS_DATA: {
        const socket = this.#sockets.get(frame.streamId);
        socket?.send(frame.payload);
        return;
      }
      case FrameType.WS_CLOSE: {
        const socket = this.#sockets.get(frame.streamId);
        const payload = decodeJson<WsClose>(frame.payload);
        socket?.close(payload.code, payload.reason);
        this.#sockets.delete(frame.streamId);
        return;
      }
      case FrameType.FLOW_CREDIT: {
        const grant = decodeJson<{ bytes: number }>(frame.payload).bytes;
        this.#windows.get(frame.streamId)?.grant(grant);
        this.#creditWaiters.get(frame.streamId)?.();
        return;
      }
      case FrameType.PING:
        this.#sendFrame(FrameType.PONG, 0, new Uint8Array());
        return;
      default:
        return;
    }
  }

  dispose(code: ErrorCode = "stream-aborted"): void {
    for (const streamId of [...this.#pending.keys()]) {
      this.#pending.delete(streamId);
      this.#error(streamId, code);
    }
    for (const socket of this.#sockets.values()) socket.close(1001, "gateway dispose");
    this.#sockets.clear();
  }

  async #performRequest(streamId: number): Promise<void> {
    const pending = this.#pending.get(streamId);
    if (!pending) return;
    this.#pending.delete(streamId);

    const body = pending.chunks.length ? concat(pending.chunks, pending.bytes) : null;
    const url = toAbsoluteUrl(pending.head.path, this.#deps.loopbackOrigin);

    try {
      let response = await this.#fetchWithCookie(url, pending, body);
      if (response.status === 401) {
        response = await this.#fetchWithCookie(url, pending, body, true);
      }

      const head: HttpResponseHead = {
        status: response.status,
        headers: filterResponseHeaders(headersToObject(response.headers)),
      };
      this.#sendFrame(FrameType.HTTP_RESPONSE_HEAD, streamId, encodeJson(head));

      if (response.body) {
        const reader = response.body.getReader();
        const window = new FlowWindow();
        this.#windows.set(streamId, window);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const chunk of splitPayload(value, this.#deps.maxFrameBytes ?? MAX_FRAME_BYTES)) {
            await this.#awaitCredit(streamId, window);
            this.#sendFrame(FrameType.HTTP_RESPONSE_BODY, streamId, chunk);
            window.consume(chunk.byteLength);
          }
        }
      }
      this.#sendFrame(FrameType.HTTP_RESPONSE_END, streamId, new Uint8Array());
    } catch (err) {
      const code: ErrorCode =
        err instanceof Error && /timeout/i.test(err.message) ? "upstream-timeout" : "upstream-unreachable";
      this.#error(streamId, code);
    } finally {
      this.#windows.delete(streamId);
      this.#creditWaiters.delete(streamId);
    }
  }

  async #fetchWithCookie(
    url: string,
    pending: PendingRequest,
    body: Uint8Array | null,
    refresh = false,
  ): Promise<Response> {
    const hostCookie = await this.#deps.mintHostCookie(refresh);
    const headers = rewriteRequestHeaders(pending.head.headers ?? {}, {
      loopbackOrigin: this.#deps.loopbackOrigin,
      hostCookie,
    });
    const init: RequestInit = { method: pending.head.method, headers, redirect: "manual" };
    if (body) init.body = body as unknown as BodyInit;
    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    return await fetchImpl(url, init);
  }

  #openSocket(streamId: number, open: WsOpen): void {
    const origin = this.#deps.loopbackOrigin.replace(/^http/, "ws");
    const url = toAbsoluteUrl(open.path, origin);
    const openSocket =
      this.#deps.openSocket ??
      ((target: string, headers: Record<string, string>) =>
        new WebSocket(target, { headers } as never) as unknown as WsClientLike);

    void this.#deps.mintHostCookie().then((hostCookie) => {
      const headers = rewriteRequestHeaders(open.headers ?? {}, {
        loopbackOrigin: this.#deps.loopbackOrigin,
        hostCookie,
      });
      const socket = openSocket(url, headers);
      this.#sockets.set(streamId, socket);
      socket.addEventListener("open", () => {
        this.#sendFrame(FrameType.WS_OPEN_ACK, streamId, encodeJson({ ok: true }));
      });
      socket.addEventListener("message", (event) => {
        const data = (event as { data?: ArrayBuffer | Uint8Array | string }).data;
        if (data === undefined) return;
        const bytes =
          typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
        const flags = typeof data === "string" ? 1 : 0;
        this.#sendFrame(FrameType.WS_DATA, streamId, bytes, flags);
      });
      socket.addEventListener("close", (event) => {
        const ev = event as { code?: number; reason?: string };
        this.#sendFrame(
          FrameType.WS_CLOSE,
          streamId,
          encodeJson({ code: ev.code ?? 1000, reason: ev.reason ?? "" }),
        );
        this.#sockets.delete(streamId);
      });
      socket.addEventListener("error", () => {
        this.#sendFrame(FrameType.WS_OPEN_ACK, streamId, encodeJson({ ok: false, reason: "upstream-unreachable" }));
      });
    });
  }

  async #awaitCredit(streamId: number, window: FlowWindow): Promise<void> {
    if (!window.exhausted) return;
    const waiter = new Promise<void>((resolve) => {
      this.#creditWaiters.set(streamId, resolve);
    });
    await Promise.race([waiter, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }

  #error(streamId: number, code: ErrorCode): void {
    this.#sendFrame(FrameType.ERROR, streamId, encodeJson({ code, message: code, streamId }));
  }

  #sendFrame(type: number, streamId: number, payload: Uint8Array, flags = 0): void {
    this.#deps.send(encodeFrame({ type: type as never, streamId, flags, payload }));
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}
