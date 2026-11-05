import {
  BACKOFF_MS,
  FrameType,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  encodeJson,
} from "../../protocol/src/index.ts";
import type { AgentHello, Frame, RelayHelloAck } from "../../protocol/src/index.ts";

export interface SocketLike {
  /** 出站缓冲区字节数（undici/Node 的 WS 都有）：用它做真正的背压 */
  readonly bufferedAmount?: number;
  /** 某些实现返回 Blob/字符串，需要显式要求二进制帧 */
  binaryType?: string;
  send(data: Uint8Array | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (event: unknown) => void): void;
}

export type TunnelStatus = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface TunnelOptions {
  url: string;
  installId: string;
  agentVersion: string;
  dshVersion: string;
  capabilities: string[];
  onFrame?: (frame: Frame) => void;
  onStatus?: (status: TunnelStatus, detail?: string) => void;
  onHelloAck?: (ack: RelayHelloAck) => void;
}

export interface TunnelDeps {
  createSocket(url: string): SocketLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
  /** 可注入的时钟：心跳活性判定用，测试里替换成虚拟时间 */
  now?: () => number;
}

/** 探测间隔：中转收到 PING 会立刻回 PONG，所以「多久没收到任何帧」能反映链路死活 */
const PING_INTERVAL_MS = 5_000;
/** 超过这个时间一帧都没收到，就认定链路半开，主动断开重连 */
const SILENCE_LIMIT_MS = 15_000;

const CLOSE_PROTOCOL_VERSION = 4002;
const CLOSE_AGENT_ALREADY_CONNECTED = 4003;

/** 出站隧道：握手、心跳、退避重连。传输由 deps.createSocket 注入，便于测试与替换。 */
/** 失败原因分类：用于状态页与重连策略（不暴露给远端页面） */
export type FailureReason =
  | "hello-timeout"
  | "protocol-version"
  | "agent-already-connected"
  | "protocol-error"
  | "dns"
  | "tls"
  | "unauthorized"
  | "quota"
  | "network";

export function classifyFailure(code: number, message = ""): FailureReason {
  if (code === 4001) return "hello-timeout";
  if (code === 4002) return "protocol-version";
  if (code === 4003) return "agent-already-connected";
  if (code === 4004) return "protocol-error";
  if (code === 4401) return "unauthorized";
  if (code === 4402) return "quota";
  const lower = message.toLowerCase();
  if (lower.includes("enotfound") || lower.includes("getaddrinfo")) return "dns";
  if (lower.includes("certificate") || lower.includes("cert") || lower.includes("tls") || lower.includes("ssl")) return "tls";
  return "network";
}

export class AgentTunnel {
  readonly #options: TunnelOptions;
  readonly #createSocket: (url: string) => SocketLike;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #random: () => number;

  #socket: SocketLike | null = null;
  #status: TunnelStatus = "idle";
  #failure: FailureReason | null = null;
  #lastError = "";
  #attempt = 0;
  #stopped = false;
  #timers = new Set<unknown>();

  constructor(options: TunnelOptions, deps: TunnelDeps) {
    this.#options = options;
    this.#createSocket = deps.createSocket;
    this.#setTimeout = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#random = deps.random ?? Math.random;
    this.#now = deps.now ?? Date.now;
  }

  get status(): TunnelStatus {
    return this.#status;
  }

  get failure(): FailureReason | null {
    return this.#failure;
  }

  /** 诊断计数：连接建立次数与收到的帧数（判断是不是在反复重连） */
  readonly #diag = { connects: 0, framesIn: 0, pingsOut: 0, lastFrameAgoMs: 0 };

  diagnostics(): { connects: number; framesIn: number; pingsOut: number; lastFrameAgoMs: number } {
    return { ...this.#diag, lastFrameAgoMs: this.#lastFrameAt ? this.#now() - this.#lastFrameAt : -1 };
  }

  /** 出站缓冲区：上层据此限速，避免把十几兆一次性塞进 WS 再也吐不出来 */
  get bufferedAmount(): number {
    const amount = this.#socket?.bufferedAmount;
    return typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  }

  start(): void {
    if (this.#stopped || this.#socket) return;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    for (const handle of this.#timers) this.#clearTimeout(handle);
    this.#timers.clear();
    this.#socket?.close(1000, "client stop");
    this.#socket = null;
    this.#setStatus("idle");
  }

  /** 返回 false 表示当前没有可用连接（调用方应把对应流判失败，而不是抛异常） */
  send(frame: Frame | Uint8Array): boolean {
    const socket = this.#socket;
    if (!socket) return false;
    try {
      socket.send(frame instanceof Uint8Array ? frame : encodeFrame(frame));
      return true;
    } catch {
      // 连接在发送瞬间被关闭：按未连接处理，避免把异常抛进事件回调
      return false;
    }
  }

  #connect(): void {
    this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting");
    const socket = this.#createSocket(this.#options.url);
    // Node/undici 的 WebSocket 默认把二进制帧当 Blob 交付，必须显式要求 arraybuffer
    if ("binaryType" in socket) socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#diag.connects += 1;
      this.#lastFrameAt = this.#now();
      this.#setStatus("connected");
      this.#sendHello(socket);
      this.#startHeartbeat(socket);
    });

    socket.addEventListener("message", (event) => {
      const data = (event as { data?: ArrayBuffer | Uint8Array | Blob }).data;
      if (!data) return;
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        void data.arrayBuffer().then((buf) => this.#handleFrame(socket, buf));
        return;
      }
      this.#handleFrame(socket, data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
    });

    socket.addEventListener("close", (event) => {
      const ev = event as { code?: number; reason?: string };
      const code = ev.code ?? 1006;
      this.#socket = null;
      this.#clearHeartbeat();
      if (this.#stopped) return;
      this.#failure = classifyFailure(code, `${ev.reason ?? ""} ${this.#lastError}`);
      if (code === CLOSE_PROTOCOL_VERSION) {
        this.#setStatus("failed", this.#failure);
        return;
      }
      // 4003 表示中转上还挂着更新的连接（刚重连时旧 socket 还没清掉）。
      // 重试几次能抢回来；但无限重试会让新旧实例互相顶掉、来回打架，
      // 所以要设上限，超过就停在这里，由状态页提示用户手动重连。
      if (code === CLOSE_AGENT_ALREADY_CONNECTED) {
        this.#takeoverAttempts += 1;
        if (this.#takeoverAttempts <= 2) {
          this.#scheduleReconnect();
          return;
        }
        this.#setStatus("failed", this.#failure);
        return;
      }
      // 凭证无效与额度受限需要人工处理，不无限重试
      if (this.#failure === "unauthorized" || this.#failure === "quota") {
        this.#setStatus("failed", this.#failure);
        return;
      }
      this.#scheduleReconnect();
    });

    socket.addEventListener("error", (event) => {
      const err = event as { message?: string; error?: { message?: string } };
      this.#lastError = err.message ?? err.error?.message ?? "";
    });
  }

  #handleFrame(socket: SocketLike, raw: Uint8Array | ArrayBuffer): void {
    this.#lastFrameAt = this.#now();
    this.#diag.framesIn += 1;
    let frame: Frame;
    try {
      frame = decodeFrame(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
    } catch {
      socket.close(4004, "protocol error");
      return;
    }
    if (frame.type === FrameType.RELAY_HELLO_ACK) {
      // 只有稳定连上一分钟才算真的站稳：过早清零会让两个实例无限互顶
      this.#clearTakeoverReset();
      this.#takeoverResetHandle = this.#setTimeout(() => {
        this.#takeoverAttempts = 0;
      }, 60_000);
      this.#timers.add(this.#takeoverResetHandle);
      this.#options.onHelloAck?.(
        JSON.parse(new TextDecoder().decode(frame.payload)) as RelayHelloAck,
      );
      return;
    }
    if (frame.type === FrameType.PING) {
      socket.send(encodeFrame({ type: FrameType.PONG, streamId: 0, flags: 0, payload: new Uint8Array() }));
      return;
    }
    if (frame.type === FrameType.PONG) return;
    try {
      this.#options.onFrame?.(frame);
    } catch {
      // 单帧处理失败不应带崩宿主进程：丢弃该帧，连接继续
    }
  }

  #sendHello(socket: SocketLike): void {
    const hello: AgentHello = {
      installId: this.#options.installId,
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: this.#options.agentVersion,
      dshVersion: this.#options.dshVersion,
      capabilities: this.#options.capabilities,
    };
    socket.send(encodeFrame({ type: FrameType.AGENT_HELLO, streamId: 0, flags: 0, payload: encodeJson(hello) }));
  }

  #heartbeatHandle: unknown = null;
  /** 被顶掉后已尝试抢回的次数：用于避免新旧实例互相顶来顶去 */
  #takeoverAttempts = 0;
  #takeoverResetHandle: unknown = null;

  #clearTakeoverReset(): void {
    if (this.#takeoverResetHandle !== null) {
      this.#clearTimeout(this.#takeoverResetHandle);
      this.#timers.delete(this.#takeoverResetHandle);
      this.#takeoverResetHandle = null;
    }
  }
  /** 最近一次收到任何帧的时间：心跳靠它判断链路是不是哑了 */
  #lastFrameAt = 0;
  #now: () => number;

  #startHeartbeat(socket: SocketLike): void {
    this.#clearHeartbeat();
    this.#heartbeatHandle = this.#setTimeout(() => {
      if (this.#socket !== socket) return;
      // 只要还有帧回来（PONG 也算）就认为链路活着；两拍都没动静说明是半开连接
      if (this.#now() - this.#lastFrameAt > SILENCE_LIMIT_MS) {
        try {
          socket.close(1011, "heartbeat timeout");
        } catch {
          // 关闭失败也照样重连
        }
        return;
      }
      try {
        this.#diag.pingsOut += 1;
        socket.send(encodeFrame({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() }));
      } catch {
        socket.close(1011, "heartbeat failed");
        return;
      }
      this.#startHeartbeat(socket);
    }, PING_INTERVAL_MS);
    this.#timers.add(this.#heartbeatHandle);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatHandle !== null) {
      this.#clearTimeout(this.#heartbeatHandle);
      this.#timers.delete(this.#heartbeatHandle);
      this.#heartbeatHandle = null;
    }
  }

  #scheduleReconnect(): void {
    const index = Math.min(this.#attempt, BACKOFF_MS.length - 1);
    const base = BACKOFF_MS[index] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 5_000;
    const jittered = Math.round(base * (0.8 + this.#random() * 0.4));
    this.#attempt += 1;
    this.#setStatus("reconnecting", `retry-in-${jittered}ms`);
    const handle = this.#setTimeout(() => {
      this.#timers.delete(handle);
      if (!this.#stopped) this.#connect();
    }, jittered);
    this.#timers.add(handle);
  }

  #setStatus(status: TunnelStatus, detail?: string): void {
    if (status === "connected") this.#failure = null;
    this.#status = status;
    this.#options.onStatus?.(status, detail);
  }
}
