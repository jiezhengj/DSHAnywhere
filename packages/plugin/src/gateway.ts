import {
  FrameFlags,
  FrameType,
  wsFragmentSizes,
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
import { BROWSER_COOKIE } from "./rewrite.ts";
import { renderDisabledPage, renderUnauthorizedPage } from "./pages.ts";

export interface WsClientLike {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (event: unknown) => void): void;
  binaryType?: string;
}

export interface GatewayDeps {
  loopbackOrigin: string;
  mintHostCookie: (force?: boolean) => Promise<string>;
  send: (bytes: Uint8Array) => void | boolean;
  fetchImpl?: typeof fetch;
  openSocket?: (url: string, headers: Record<string, string>) => WsClientLike;
  maxFrameBytes?: number;
  /** 每个请求实时鉴权：非 ok 时回对应提示页，不触碰 loopback */
  authorize?: (headers: Record<string, string>) => "ok" | "unpaired" | "disabled";
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
  readonly #wsParts = new Map<number, Uint8Array[]>();

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
        const parts = this.#wsParts.get(frame.streamId) ?? [];
        parts.push(frame.payload);
        if ((frame.flags & FrameFlags.WS_MORE) !== 0) {
          this.#wsParts.set(frame.streamId, parts);
          return;
        }
        this.#wsParts.delete(frame.streamId);
        if (!socket) return;
        const whole = parts.length === 1 ? parts[0]! : concat(parts, parts.reduce((n, p) => n + p.byteLength, 0));
        // DSH 的实时通道只接受文本帧：必须保留文本标记
        if ((frame.flags & FrameFlags.WS_TEXT) !== 0) {
          socket.send(new TextDecoder().decode(whole));
        } else {
          socket.send(whole);
        }
        return;
      }
      case FrameType.WS_CLOSE: {
        const socket = this.#sockets.get(frame.streamId);
        const payload = decodeJson<WsClose>(frame.payload);
        if (socket) closeSafely(socket, payload.code, payload.reason);
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
    if (pending.head.path.startsWith("/__anywhere/")) {
      const denied: HttpResponseHead = { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } };
      this.#sendFrame(FrameType.HTTP_RESPONSE_HEAD, streamId, encodeJson(denied));
      this.#sendFrame(FrameType.HTTP_RESPONSE_END, streamId, new Uint8Array());
      return;
    }

    const url = toAbsoluteUrl(pending.head.path, this.#deps.loopbackOrigin);

    // 配对页本身必须免鉴权：否则未配对浏览器永远拿不到能力链接
    const gate = isPairingPath(pending.head.path)
      ? "ok"
      : (this.#deps.authorize?.(pending.head.headers ?? {}) ?? "ok");
    if (gate !== "ok") {
      const head: HttpResponseHead = {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
      };
      if (gate === "disabled") head.status = 503;
      this.#sendFrame(FrameType.HTTP_RESPONSE_HEAD, streamId, encodeJson(head));
      const page = gate === "disabled" ? renderDisabledPage() : renderUnauthorizedPage();
      this.#sendFrame(FrameType.HTTP_RESPONSE_BODY, streamId, new TextEncoder().encode(page));
      this.#sendFrame(FrameType.HTTP_RESPONSE_END, streamId, new Uint8Array());
      return;
    }

    try {
      let response = await this.#fetchWithCookie(url, pending, body);
      if (response.status === 401) {
        response = await this.#fetchWithCookie(url, pending, body, true);
      }

      const responseHeaders = filterResponseHeaders(headersToObject(response.headers));
      // 只放行插件自己签发的设备 cookie；loopback 的会话 cookie 仍然不能外泄
      const ownCookies = (response.headers.getSetCookie?.() ?? []).filter((line) =>
        line.startsWith(`${BROWSER_COOKIE}=`),
      );
      if (ownCookies.length > 0) responseHeaders["set-cookie"] = ownCookies[0]!;
      const head: HttpResponseHead = {
        status: response.status,
        headers: responseHeaders,
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
    const wsGate = this.#deps.authorize?.(open.headers ?? {}) ?? "ok";
    if (wsGate !== "ok") {
      this.#sendFrame(FrameType.WS_OPEN_ACK, streamId, encodeJson({ ok: false, reason: wsGate }));
      return;
    }
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
        const isText = typeof data === "string";
        const bytes = isText ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
        // 一条 WS 消息可能远超单帧上限：切片传输，末片不带 WS_MORE
        const sizes = wsFragmentSizes(bytes.byteLength);
        let offset = 0;
        for (let i = 0; i < sizes.length; i += 1) {
          const size = sizes[i]!;
          const more = i < sizes.length - 1;
          this.#sendFrame(
            FrameType.WS_DATA,
            streamId,
            bytes.subarray(offset, offset + size),
            (isText ? FrameFlags.WS_TEXT : 0) | (more ? FrameFlags.WS_MORE : 0),
          );
          offset += size;
        }
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
    try {
      this.#deps.send(encodeFrame({ type: type as never, streamId, flags, payload }));
    } catch {
      // 连接在发送瞬间断开：丢弃这一帧，重连由隧道负责；绝不让异常冒泡到事件回调
    }
  }
}

/**
 * 关闭码必须是 RFC6455 允许的值：undici 收到 0/1006/undefined 会抛 DOMException，
 * 而这类异常发生在 WS_CLOSE 回调里会直接带崩宿主进程（实测）。
 */
/** 配对入口：`/p/<一次性令牌>` 必须在鉴权之前放行 */
export function isPairingPath(path: string): boolean {
  return /^\/p\/[A-Za-z0-9_-]{20,}$/.test(path.split("?")[0] ?? "");
}

function closeSafely(socket: WsClientLike, code: number | undefined, reason: string | undefined): void {
  const allowed =
    typeof code === "number" &&
    code >= 1000 &&
    code <= 4999 &&
    ![1004, 1005, 1006, 1015].includes(code);
  try {
    socket.close(allowed ? code : 1000, reason ?? "");
  } catch {
    try {
      socket.close(1000, "");
    } catch {
      // 已经关闭：忽略
    }
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
