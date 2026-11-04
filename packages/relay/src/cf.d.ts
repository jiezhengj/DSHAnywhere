// 最小化的 Cloudflare 运行时类型；仅用于类型检查，运行时由 workerd 提供。
export {};

declare global {
  interface DurableObjectId {
    toString(): string;
  }

  interface DurableObjectStub {
    fetch(input: Request): Promise<Response>;
  }

  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  /** workerd 提供：WebSocketPair 的 0/1 分别是 client 与 server 端 */
  declare const WebSocketPair: {
    new (): Record<string, WebSocket>;
  };

  /** workerd 的 Response 支持 webSocket 选项（101 升级） */
  interface ResponseInit {
    webSocket?: WebSocket;
  }

  interface DurableObjectState {
    acceptWebSocket?(socket: WebSocket): void;
    storage: unknown;
  }
}
