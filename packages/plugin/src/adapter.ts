import { probeHostSurface } from "./version.ts";
import type { HostSurface, ProbeResult } from "./version.ts";

/** DSH 侧可能传入的请求/响应对象；插件只按结构化字段使用 */
export interface HostRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

export interface HostResponse {
  statusCode?: number;
  status?: number;
  setHeader?(name: string, value: string | string[]): void;
  end?(chunk?: string | Uint8Array): void;
  [key: string]: unknown;
}

export type HostHandler = (req: HostRequest, res: HostResponse, next?: () => void) => unknown;
export type Disposer = () => void;

export interface WebServerLike {
  getOrigin(): string;
  register(route: unknown): Disposer;
  registerUpgrade(route: unknown, handler: unknown): Disposer;
  protocol?: string;
  port?: number;
}

export interface ConnectionLike {
  authenticatedUrl(base: string): string;
  admit?(req: unknown): boolean;
}

export interface AdapterOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** host cookie 复用窗口（毫秒）；到期前不重复换发 */
  cookieTtlMs?: number;
}

export class ContractViolation extends Error {
  override readonly name: string = "ContractViolation";
  readonly probe: ProbeResult;

  constructor(probe: ProbeResult) {
    super(probe.ok ? "契约探测通过" : `DSH 契约不兼容：${probe.reason}（${probe.detail}）`);
    this.probe = probe;
  }
}

/**
 * 唯一允许接触 DSH 内部契约的适配层。对外只暴露四个函数，
 * 其它模块不得持有多宿主对象（Constitution I）。
 */
export class Adapter {
  readonly #webServer: WebServerLike;
  readonly #connection: ConnectionLike;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cookieTtlMs: number;

  #cookie: { value: string; expiresAt: number } | null = null;

  constructor(
    surface: HostSurface & { webServer?: unknown; connection?: unknown },
    options: AdapterOptions = {},
  ) {
    const probe = probeHostSurface(surface);
    if (!probe.ok) throw new ContractViolation(probe);
    this.#webServer = surface.webServer as WebServerLike;
    this.#connection = surface.connection as ConnectionLike;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#cookieTtlMs = options.cookieTtlMs ?? 10 * 60 * 1000;
  }

  registerRoute(kind: "exact" | "prefix", path: string, handler: HostHandler): Disposer {
    const route = kind === "exact" ? { kind, path, handler } : { kind, path, handler };
    const disposer = this.#webServer.register(route);
    return typeof disposer === "function" ? disposer : () => {};
  }

  registerUpgradeRoute(path: string, handler: HostHandler): Disposer {
    const disposer = this.#webServer.registerUpgrade({ path, handler }, handler);
    return typeof disposer === "function" ? disposer : () => {};
  }

  getLoopbackOrigin(): string {
    return this.#webServer.getOrigin();
  }

  /**
   * 换取宿主自身的会话 cookie：GET authenticatedUrl(origin) 期望 303，
   * 从 Set-Cookie 取出 `dsh-auth-*` 值，供转发时以 Cookie 头发送。
   */
  async mintHostCookie(force = false): Promise<string> {
    const cached = this.#cookie;
    if (!force && cached && cached.expiresAt > this.#now()) return cached.value;

    const url = this.#connection.authenticatedUrl(this.getLoopbackOrigin());
    const response = await this.#fetch(url, { method: "GET", redirect: "manual" });

    const raw =
      typeof response.headers?.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers?.get?.("set-cookie") ?? ""];

    const found = raw
      .map((line) => line.split(";")[0]?.trim() ?? "")
      .find((pair) => pair.startsWith("dsh-auth-"));

    if (!found) {
      throw new Error(
        `换取宿主 cookie 失败：状态 ${response.status}，未返回 dsh-auth-* cookie`,
      );
    }

    this.#cookie = { value: found, expiresAt: this.#now() + this.#cookieTtlMs };
    return found;
  }

  /** 供测试与调试：清空 cookie 缓存 */
  resetCookieCache(): void {
    this.#cookie = null;
  }
}
