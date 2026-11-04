import {
  BACKOFF_MS,
  FrameType,
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  encodeJson,
} from "../../protocol/src/index.ts";
import type { AgentHello, Frame, RelayHelloAck } from "../../protocol/src/index.ts";

export interface SocketLike {
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
}

const CLOSE_PROTOCOL_VERSION = 4002;
const CLOSE_AGENT_ALREADY_CONNECTED = 4003;

/** 出站隧道：握手、心跳、退避重连。传输由 deps.createSocket 注入，便于测试与替换。 */
export class AgentTunnel {
  readonly #options: TunnelOptions;
  readonly #createSocket: (url: string) => SocketLike;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #random: () => number;

  #socket: SocketLike | null = null;
  #status: TunnelStatus = "idle";
  #attempt = 0;
  #stopped = false;
  #timers = new Set<unknown>();

  constructor(options: TunnelOptions, deps: TunnelDeps) {
    this.#options = options;
    this.#createSocket = deps.createSocket;
    this.#setTimeout = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#random = deps.random ?? Math.random;
  }

  get status(): TunnelStatus {
    return this.#status;
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

  send(frame: Frame): void {
    if (!this.#socket) throw new Error("隧道未连接");
    this.#socket.send(encodeFrame(frame));
  }

  #connect(): void {
    this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting");
    const socket = this.#createSocket(this.#options.url);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#setStatus("connected");
      this.#sendHello(socket);
      this.#startHeartbeat(socket);
    });

    socket.addEventListener("message", (event) => {
      const data = (event as { data?: ArrayBuffer | Uint8Array }).data;
      if (!data) return;
      let frame: Frame;
      try {
        frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
      } catch {
        socket.close(4004, "protocol error");
        return;
      }
      if (frame.type === FrameType.RELAY_HELLO_ACK) {
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
      this.#options.onFrame?.(frame);
    });

    socket.addEventListener("close", (event) => {
      const code = (event as { code?: number }).code ?? 1006;
      this.#socket = null;
      this.#clearHeartbeat();
      if (this.#stopped) return;
      if (code === CLOSE_PROTOCOL_VERSION) {
        this.#setStatus("failed", "protocol-version");
        return;
      }
      if (code === CLOSE_AGENT_ALREADY_CONNECTED) {
        this.#setStatus("failed", "agent-already-connected");
        return;
      }
      this.#scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // 具体原因由随后的 close 事件给出，这里不重复处理
    });
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

  #startHeartbeat(socket: SocketLike): void {
    this.#clearHeartbeat();
    this.#heartbeatHandle = this.#setTimeout(() => {
      if (this.#socket !== socket) return;
      try {
        socket.send(encodeFrame({ type: FrameType.PING, streamId: 0, flags: 0, payload: new Uint8Array() }));
      } catch {
        socket.close(1011, "heartbeat failed");
        return;
      }
      this.#startHeartbeat(socket);
    }, HEARTBEAT_MS);
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
    this.#status = status;
    this.#options.onStatus?.(status, detail);
  }
}
