import {
  FrameFlags,
  FrameType,
  MAX_FRAME_BYTES,
  REQUEST_TIMEOUT_MS,
  WINDOW_BYTES,
  decodeFrame,
  encodeFrame,
  encodeJson,
} from "../../protocol/src/index.ts";
import type { ErrorCode, Frame, HttpRequestHead, HttpResponseHead, WsOpen } from "../../protocol/src/index.ts";

export interface AgentTransport {
  send(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface HttpSink {
  head(status: number, headers: Record<string, string>): void;
  body(chunk: Uint8Array): void;
  end(): void;
  fail(code: ErrorCode): void;
}

export interface WsSink {
  open(): void;
  data(chunk: Uint8Array, isText: boolean): void;
  close(code: number, reason: string): void;
  fail(code: ErrorCode): void;
}

interface StreamState {
  sink: HttpSink;
  window: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeOptions {
  timeoutMs?: number;
  windowBytes?: number;
  maxFrameBytes?: number;
}

/**
 * 中转侧的多路复用核心：把浏览器请求压成帧发给 agent，再把 agent 的响应帧
 * 还原成响应流。与 Cloudflare 运行时无关，可在 node:test 里直接驱动。
 */
export class RelayBridge {
  readonly #transport: AgentTransport;
  readonly #timeoutMs: number;
  readonly #windowBytes: number;
  readonly #maxFrameBytes: number;
  readonly #streams = new Map<number, StreamState>();
  readonly #wsStreams = new Map<number, WsSink>();
  #nextStreamId = 1;

  constructor(transport: AgentTransport, options: BridgeOptions = {}) {
    this.#transport = transport;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#windowBytes = options.windowBytes ?? WINDOW_BYTES;
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  get openStreams(): number {
    return this.#streams.size;
  }

  request(head: HttpRequestHead, body: Uint8Array | null, sink: HttpSink): number {
    const streamId = this.#nextStreamId++;
    const timer = setTimeout(() => {
      this.#streams.delete(streamId);
      sink.fail("upstream-timeout");
    }, this.#timeoutMs);
    this.#streams.set(streamId, { sink, window: this.#windowBytes, timer });

    this.#send(FrameType.HTTP_REQUEST_HEAD, streamId, encodeJson(head));
    if (body && body.byteLength > 0) {
      for (let offset = 0; offset < body.byteLength; offset += this.#maxFrameBytes) {
        const chunk = body.subarray(offset, offset + this.#maxFrameBytes);
        this.#send(FrameType.HTTP_REQUEST_BODY, streamId, chunk);
      }
    }
    this.#send(FrameType.HTTP_REQUEST_END, streamId, new Uint8Array());
    return streamId;
  }

  /** 打开一条 WS 透传流（浏览器 ↔ agent 的 /api/remote.mux） */
  openWs(open: WsOpen, sink: WsSink): number {
    const streamId = this.#nextStreamId++;
    this.#wsStreams.set(streamId, sink);
    this.#send(FrameType.WS_OPEN, streamId, encodeJson(open));
    return streamId;
  }

  /** 浏览器侧数据帧 */
  sendWsData(streamId: number, chunk: Uint8Array, isText = false): void {
    this.#send(FrameType.WS_DATA, streamId, chunk, isText ? FrameFlags.WS_TEXT : 0);
  }

  closeWs(streamId: number, code: number, reason: string): void {
    this.#send(FrameType.WS_CLOSE, streamId, encodeJson({ code, reason }));
    this.#wsStreams.delete(streamId);
  }

  /** 收到 agent 帧；返回 false 表示该帧不被中转接受（调用方应关闭连接） */
  onFrame(frame: Frame): boolean {
    const stream = this.#streams.get(frame.streamId);
    switch (frame.type) {
      case FrameType.HTTP_RESPONSE_HEAD: {
        const head = JSON.parse(new TextDecoder().decode(frame.payload)) as HttpResponseHead;
        stream?.sink.head(head.status, head.headers);
        return true;
      }
      case FrameType.HTTP_RESPONSE_BODY: {
        if (!stream) return true;
        stream.sink.body(frame.payload);
        stream.window -= frame.payload.byteLength;
        if (stream.window <= this.#windowBytes / 2) {
          const grant = this.#windowBytes - stream.window;
          stream.window += grant;
          this.#send(FrameType.FLOW_CREDIT, frame.streamId, encodeJson({ bytes: grant }));
        }
        return true;
      }
      case FrameType.HTTP_RESPONSE_END:
        this.#settle(frame.streamId, (s) => s.sink.end());
        return true;
      case FrameType.ERROR: {
        const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as { code?: string };
        const code = (payload.code ?? "protocol") as ErrorCode;
        this.#settle(frame.streamId, (s) => s.sink.fail(code));
        return true;
      }
      case FrameType.WS_OPEN_ACK: {
        const ack = JSON.parse(new TextDecoder().decode(frame.payload)) as { ok?: boolean; reason?: string };
        const sink = this.#wsStreams.get(frame.streamId);
        if (!ack.ok) {
          sink?.fail((ack.reason as ErrorCode) ?? "upstream-unreachable");
          this.#wsStreams.delete(frame.streamId);
        } else {
          sink?.open();
        }
        return true;
      }
      case FrameType.WS_DATA: {
        const sink = this.#wsStreams.get(frame.streamId);
        sink?.data(frame.payload, (frame.flags & FrameFlags.WS_TEXT) !== 0);
        return true;
      }
      case FrameType.WS_CLOSE: {
        const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as { code?: number; reason?: string };
        this.#wsStreams.get(frame.streamId)?.close(payload.code ?? 1000, payload.reason ?? "");
        this.#wsStreams.delete(frame.streamId);
        return true;
      }
      case FrameType.PING:
        this.#send(FrameType.PONG, 0, new Uint8Array());
        return true;
      case FrameType.PONG:
        return true;
      default:
        return false;
    }
  }

  /** 关闭所有在途请求并释放资源 */
  dispose(code: ErrorCode = "stream-aborted"): void {
    for (const [, state] of this.#streams) {
      clearTimeout(state.timer);
      state.sink.fail(code);
    }
    this.#streams.clear();
    for (const sink of this.#wsStreams.values()) sink.fail(code);
    this.#wsStreams.clear();
  }

  #settle(streamId: number, done: (state: StreamState) => void): void {
    const state = this.#streams.get(streamId);
    if (!state) return;
    clearTimeout(state.timer);
    this.#streams.delete(streamId);
    done(state);
  }

  #send(type: number, streamId: number, payload: Uint8Array, flags = 0): void {
    this.#transport.send(encodeFrame({ type: type as never, streamId, flags, payload }));
  }
}

/** 解码来自 agent 的二进制消息；失败即视为协议错误 */
export function decodeAgentMessage(data: ArrayBuffer | Uint8Array): Frame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return decodeFrame(bytes);
}
