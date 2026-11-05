import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Adapter, ContractViolation } from "./adapter.ts";
import { AgentTunnel } from "./agent.ts";
import type { SocketLike, TunnelStatus } from "./agent.ts";
import { authenticate, readCookie, recordSuccess } from "./auth.ts";
import { parseConfig, isConfigured } from "./config.ts";
import type { PluginConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { handlePairing } from "./pairing.ts";
import { renderIncompatiblePage, renderStatusPage } from "./pages.ts";
import { handleStatusApi } from "./status.ts";
import { probeHostSurface } from "./version.ts";
import type { StatusContext } from "./status.ts";
import { Store, emptyState } from "./store.ts";
import type { StoreState } from "./store.ts";
import { BROWSER_COOKIE } from "./rewrite.ts";

export const PLUGIN_NAME = "dsh-anywhere";
export const CONTRACT_VERSION = { expected: "0.2.x", actual: "0.2.1-rc.5" };
/** DSH 0.2.1-rc.5 唯一的实时升级端点（dsh-api-gateway 内部常量） */
export const MUX_PATH = "/api/remote.mux";

export interface PluginLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface PluginHost {
  webServer?: unknown;
  connection?: unknown;
  muxPath?: string;
  logger?: PluginLogger;
}

export interface RuntimeOptions {
  storageDir: string;
  /** 管理页静态资源目录；默认与插件源码同级的 ui/ */
  uiDir?: string;
  createSocket: (url: string) => SocketLike;
  dshVersion?: string;
  agentVersion?: string;
  now?: () => number;
  installId?: string;
}

interface HostRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
}

interface HostResponseLike {
  statusCode?: number;
  setHeader?(name: string, value: string): void;
  end?(body?: string | Uint8Array): void;
}

export interface PluginRuntime {
  config: PluginConfig;
  store: Store;
  state(): StoreState;
  status(): { connection: TunnelStatus; relayOrigin: string | null; disabled?: string };
  stop(): void;
  /** 卸载时释放路由与隧道：Cordis 重新装配插件前必须先清干净，否则报 duplicate prefix route */
  dispose(): void;
}

/** 日志通道兜底：ctx.logger 不是可 inject 的服务，访问失败就退回 console */
function safeLog(host: PluginHost, level: "info" | "warn" | "error", message: string): void {
  try {
    host.logger?.[level]?.(message);
    if (host.logger) return;
  } catch {
    // 忽略：Cordis 代理对未 inject 的属性会抛错
  }
  if (level === "error") console.error(`[dsh-anywhere] ${message}`);
  else console.warn(`[dsh-anywhere] ${message}`);
}

function requestPath(req: HostRequestLike): string {
  const raw = req.url ?? "/";
  try {
    return new URL(raw, "http://127.0.0.1").pathname;
  } catch {
    return raw.split("?")[0] ?? "/";
  }
}

function requestHeaders(req: HostRequestLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(", ");
  }
  return out;
}

async function readBody(req: HostRequestLike): Promise<string> {
  if (typeof req.on !== "function") return "";
  return await new Promise<string>((resolve) => {
    const chunks: string[] = [];
    req.on?.("data", (chunk) => chunks.push(String(chunk)));
    req.on?.("end", () => resolve(chunks.join("")));
    req.on?.("error", () => resolve(""));
  });
}

function send(
  res: HostResponseLike | undefined,
  status: number,
  headers: Record<string, string>,
  body: string | Uint8Array,
): void {
  if (!res || typeof res.setHeader !== "function" || typeof res.end !== "function") return;
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(body);
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * 装配运行时：状态存储、适配层、隧道、网关与全部本机路由。
 * 除 adapter 外，本文件不直接触碰 DSH 内部对象。
 */
export function createRuntime(host: PluginHost, rawConfig: unknown, options: RuntimeOptions): PluginRuntime {
  const config = parseConfig(rawConfig);
  const store = new Store(options.storageDir);
  const now = options.now ?? Date.now;
  const uiDir = options.uiDir ?? join(import.meta.dirname, "..", "ui");

  let current: StoreState = emptyState();
  const ready = store.load().then((loaded) => {
    current = loaded;
    return loaded;
  });

  // FR-027：契约探测失败必须整体禁用并给出指引；探测函数单独抽出，便于单测覆盖
  const probe = probeHostSurface({
    webServer: host.webServer as never,
    connection: host.connection as never,
    muxPath: MUX_PATH,
  });
  if (!probe.ok) {
    safeLog(host, "error", `DSHAnywhere 已禁用：${probe.detail}`);
    const webServer = host.webServer as
      | { register?: (route: { kind: "prefix"; path: string; handler: unknown }) => void }
      | undefined;
    try {
      webServer?.register?.({
        kind: "prefix",
        path: "/__anywhere",
        handler: (req: HostRequestLike, res: HostResponseLike) => {
          res.statusCode = 503;
          res.setHeader?.("content-type", "text/html; charset=utf-8");
          res.setHeader?.("cache-control", "no-store");
          res.end?.(renderIncompatiblePage(probe.detail));
        },
      });
    } catch {
      // 连注册都不可用：只能留日志，不抛异常
    }
    return {
      config,
      store,
      state: () => current,
      status: () => ({ connection: "idle", relayOrigin: null, disabled: probe.reason }),
      stop: () => {},
      dispose: () => {},
    };
  }

  let adapter: Adapter | null = null;
  try {
    // 只读取已声明的服务：Cordis 的 ctx 代理对未 inject 的属性会直接抛错
    adapter = new Adapter({
      webServer: host.webServer,
      connection: host.connection,
      // DSH 0.2.1-rc.5 的实时通道是契约常量，不通过 ctx 读取
      muxPath: MUX_PATH,
    } as never);
  } catch (err) {
    // 任何探测失败都只禁用插件，不抛出：半挂载的插件比不挂载更糟
    const detail = err instanceof ContractViolation ? err.message : err instanceof Error ? err.message : String(err);
    safeLog(host, "error", `DSHAnywhere 已禁用：${detail}`);
  }

  let connection: TunnelStatus = "idle";
  let relayOrigin: string | null = null;
  let relayFailure: "unreachable" | "quota" | undefined;
  let tunnel: AgentTunnel | null = null;

  const runtime: PluginRuntime = {
    config,
    store,
    state: () => current,
    status: () => ({ connection, relayOrigin }),
    stop: () => {
      tunnel?.stop();
      tunnel = null;
    },
    dispose: () => {
      tunnel?.stop();
      tunnel = null;
      for (const dispose of routeDisposers.splice(0)) {
        try {
          dispose();
        } catch {
          // 宿主已卸载时忽略
        }
      }
    },
  };

  if (!adapter) return runtime;
  const activeAdapter = adapter;

  // 路由注册返回的 disposer 必须留着：插件被卸载/重装时要能把路由摘掉
  const routeDisposers: (() => void)[] = [];

  const persist = async (next: StoreState): Promise<void> => {
    current = next;
    await store.save(next);
  };

  const startTunnel = (): void => {
    tunnel?.stop();
    tunnel = null;
    const target = config.relayUrl ?? current.relay?.url ?? null;
    if (!target || !current.enabled) return;
    tunnel = new AgentTunnel(
      {
        url: `${target.replace(/^http/, "ws").replace(/\/$/, "")}/__dsh_agent`,
        installId: current.installation?.installId ?? options.installId ?? "default",
        agentVersion: options.agentVersion ?? "0.0.0",
        dshVersion: options.dshVersion ?? CONTRACT_VERSION.actual,
        capabilities: ["MUX"],
        onStatus: (status) => {
          connection = status;
          if (status === "connected") relayFailure = undefined;
          else if (status === "failed") {
            const failure = tunnel?.failure ?? null;
            relayFailure = failure === "quota" ? "quota" : failure === "unauthorized" ? undefined : "unreachable";
          }
        },
        onHelloAck: (ack) => {
          relayOrigin = ack.relayOrigin;
        },
        onFrame: (frame) => {
          void gateway?.onFrame(frame);
        },
      },
      { createSocket: options.createSocket },
    );
    tunnel.start();
  };

  let statsTimer: ReturnType<typeof setTimeout> | null = null;

  const gateway = new Gateway({
    loopbackOrigin: activeAdapter.getLoopbackOrigin(),
    mintHostCookie: (force) => activeAdapter.mintHostCookie(force),
    send: (bytes) => tunnel?.send(bytes),
    bufferedAmount: () => tunnel?.bufferedAmount ?? 0,
    authorize: (headers) => {
      if (!current.enabled) return "disabled";
      const credential = readCookie(headers, BROWSER_COOKIE);
      const result = authenticate(current, credential);
      if (!result.ok) return result.reason;
      // 计一次成功请求与设备活跃时间：内存里累加，落盘做防抖，
      // 否则「今日请求」永远是 0，设备列表也看不出什么时候还在用。
      current = recordSuccess(current, result.device.id, new Date());
      if (!statsTimer) {
        statsTimer = setTimeout(() => {
          statsTimer = null;
          void store.save(current);
        }, 5_000);
      }
      return "ok";
    },
  });

  const statusContext = (): StatusContext => ({
    state: current,
    relayUrl: config.relayUrl,
    connection,
    relayOrigin,
    installId: current.installation?.installId ?? options.installId ?? "default",
    contractVersion: CONTRACT_VERSION,
    now,
    secure: true,
  });

  const applyApiResult = async (result: ReturnType<typeof handleStatusApi>): Promise<void> => {
    if (result.nextState) await persist(result.nextState);
    if (result.effect === "rebuild-tunnel" || result.effect === "start-tunnel") startTunnel();
    if (result.effect === "stop-tunnel") {
      tunnel?.stop();
      tunnel = null;
    }
  };

  routeDisposers.push(activeAdapter.registerRoute("prefix", "/__anywhere", async (req, res) => {
    await ready
    if (requestPath(req as HostRequestLike) === "/__anywhere/api/trace") {
      send(
        res as HostResponseLike,
        200,
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        JSON.stringify({ ok: true, trace: gateway.trace(), counters: gateway.counters(), tunnel: tunnel?.diagnostics() ?? null }),
      );
      return;
    };
    const path = requestPath(req as HostRequestLike);
    const method = ((req as HostRequestLike).method ?? "GET").toUpperCase();

    if (path.startsWith("/__anywhere/ui/")) {
      const name = path.slice("/__anywhere/ui/".length);
      if (!/^[a-z0-9._-]+$/i.test(name)) {
        send(res as HostResponseLike, 404, {}, "");
        return;
      }
      try {
        const content = await readFile(join(uiDir, name));
        const ext = name.slice(name.lastIndexOf("."));
        send(
          res as HostResponseLike,
          200,
          { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" },
          content,
        );
      } catch {
        send(res as HostResponseLike, 404, {}, "");
      }
      return;
    }

    if (path.startsWith("/__anywhere/api/")) {
      const body = method === "POST" ? await readBody(req as HostRequestLike) : "";
      const result = handleStatusApi(method, path, body, statusContext());
      await applyApiResult(result);
      send(res as HostResponseLike, result.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, result.body);
      return;
    }

    const view = {
      configured: isConfigured(config) || current.relay !== null,
      relayUrl: config.relayUrl ?? current.relay?.url ?? null,
      pairingUrl: null as string | null,
      connection:
        connection === "connected" ? ("已连接" as const) : connection === "reconnecting" ? ("重连中" as const) : ("未连接" as const),
      devices: current.devices.filter((d) => !d.revokedAt).map((d) => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt })),
      successCount: current.stats.success,
      failureCount: current.stats.failure,
      relayFailure,
    };
    send(
      res as HostResponseLike,
      200,
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
      renderStatusPage(view),
    );
  }));

  routeDisposers.push(activeAdapter.registerRoute("prefix", "/p", async (req, res) => {
    await ready;
    const outcome = handlePairing(requestPath(req as HostRequestLike), current, { now: now() });
    if (outcome.nextState) await persist(outcome.nextState);
    send(res as HostResponseLike, outcome.status, outcome.headers, outcome.body);
  }));

  void ready.then(() => startTunnel());
  return runtime;
}

function defaultOptions(config: PluginConfig): RuntimeOptions {
  return {
    storageDir: join(homedir(), ".dsh", "storages", "dsh-anywhere"),
    createSocket: (url: string) => new WebSocket(url) as unknown as SocketLike,
    ...(config.relayUrl ? {} : {}),
  };
}

/**
 * Cordis 插件入口。`inject` 必须显式声明：Cordis 不允许未声明就读取
 * `ctx.webServer`，直接访问会抛错并导致条目无法激活。
 */
let runtimeRef: PluginRuntime | null = null;

/** 最近一次装配出的运行时（调试与测试用） */
export function currentRuntime(): PluginRuntime | null {
  return runtimeRef;
}

const plugin = {
  name: PLUGIN_NAME,
  // Cordis 的 inject 是服务名列表；写成对象会被当成名为 required/optional 的服务
  inject: ["webServer", "connection"],
  apply(host: PluginHost, rawConfig: unknown): () => void {
    // Cordis 的 apply 不能返回对象，返回函数才是合法的释放钩子
    const runtime = createRuntime(host, rawConfig, defaultOptions(parseConfig(rawConfig)));
    runtimeRef = runtime;
    return () => {
      runtime.dispose();
      if (runtimeRef === runtime) runtimeRef = null;
    };
  },
};

export default plugin;

/** 兼容直接以函数形式装配（测试与内嵌使用） */
export function apply(host: PluginHost, rawConfig: unknown, options?: Partial<RuntimeOptions>): PluginRuntime {
  return createRuntime(host, rawConfig, {
    ...defaultOptions(parseConfig(rawConfig)),
    ...options,
  } as RuntimeOptions);
}
