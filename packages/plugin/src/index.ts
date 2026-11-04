import { Adapter, ContractViolation } from "./adapter.ts";
import { AgentTunnel } from "./agent.ts";
import type { SocketLike, TunnelStatus } from "./agent.ts";
import { parseConfig, isConfigured } from "./config.ts";
import type { PluginConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { createLink, nextLinkRecord } from "./link.ts";
import { handlePairing, PAIRING_RE } from "./pairing.ts";
import { pairingUrl, normalizeRelayUrl } from "./relay-url.ts";
import { renderStatusPage } from "./pages.ts";
import { Store } from "./store.ts";
import type { StoreState } from "./store.ts";
import { renderErrorPage, RELAY_UNREACHABLE } from "./errors.ts";

export const PLUGIN_NAME = "dsh-anywhere";

export interface PluginLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface PluginHost {
  webServer?: unknown;
  connection?: unknown;
  logger?: PluginLogger;
}

export interface RuntimeOptions {
  storageDir: string;
  createSocket: (url: string) => SocketLike;
  dshVersion?: string;
  agentVersion?: string;
  now?: () => number;
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
  end?(body?: string): void;
}

export interface PluginRuntime {
  config: PluginConfig;
  store: Store;
  status(): { connection: TunnelStatus; relayOrigin: string | null };
  stop(): void;
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

function send(res: HostResponseLike | undefined, status: number, headers: Record<string, string>, body: string): void {
  if (!res || typeof res.setHeader !== "function" || typeof res.end !== "function") return;
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(body);
}

/**
 * 装配运行时：状态存储、适配层、隧道、网关与全部本机路由。
 * 除 adapter 外，本文件不直接触碰 DSH 内部对象。
 */
export function createRuntime(host: PluginHost, rawConfig: unknown, options: RuntimeOptions): PluginRuntime {
  const config = parseConfig(rawConfig);
  const store = new Store(options.storageDir);
  const now = options.now ?? Date.now;

  let adapter: Adapter | null = null;
  try {
    adapter = new Adapter(host as never);
  } catch (err) {
    if (err instanceof ContractViolation) {
      host.logger?.error?.(`DSHAnywhere 已禁用：${err.message}`);
    } else {
      throw err;
    }
  }

  const runtime: PluginRuntime = {
    config,
    store,
    status: () => ({ connection: "idle", relayOrigin: null }),
    stop: () => tunnel?.stop(),
  };

  if (!adapter) return runtime;
  const activeAdapter = adapter;

  let connection: TunnelStatus = "idle";
  let relayOrigin: string | null = null;

  const tunnel: AgentTunnel | null = config.relayUrl
    ? new AgentTunnel(
        {
          url: `${config.relayUrl.replace(/^http/, "ws")}/__dsh_agent`,
          installId: "default",
          agentVersion: options.agentVersion ?? "0.0.0",
          dshVersion: options.dshVersion ?? "unknown",
          capabilities: ["MUX"],
          onStatus: (status) => {
            connection = status;
          },
          onHelloAck: (ack) => {
            relayOrigin = ack.relayOrigin;
          },
          onFrame: (frame) => {
            void gateway?.onFrame(frame);
          },
        },
        { createSocket: options.createSocket },
      )
    : null;

  const gateway = new Gateway({
    loopbackOrigin: activeAdapter.getLoopbackOrigin(),
    mintHostCookie: (force) => activeAdapter.mintHostCookie(force),
    send: (bytes) => tunnel?.send(bytes),
  });

  runtime.status = () => ({ connection, relayOrigin });

  const state = async (): Promise<StoreState> => await store.load();

  activeAdapter.registerRoute("prefix", "/__anywhere/", async (req, res) => {
    const path = requestPath(req as HostRequestLike);
    const current = await state();
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" };

    if (path === "/__anywhere/api/status") {
      const body = JSON.stringify({
        configured: isConfigured(config),
        relayUrl: config.relayUrl,
        connection,
        relayOrigin,
        devices: current.devices.filter((d) => !d.revokedAt).length,
        stats: current.stats,
      });
      send(res as HostResponseLike, 200, { ...headers, "content-type": "application/json" }, body);
      return;
    }

    if (path === "/__anywhere/api/relay") {
      const body = await readBody(req as HostRequestLike);
      const form = new URLSearchParams(body);
      const normalised = normalizeRelayUrl(form.get("relayUrl"));
      if (!normalised.ok) {
        send(res as HostResponseLike, 400, headers, renderErrorPage({ ...RELAY_UNREACHABLE, status: 400, title: "地址无效", hint: normalised.detail }));
        return;
      }
      config.relayUrl = normalised.origin;
      await store.save({ ...current, relay: { url: normalised.origin, connectedAt: new Date(now()).toISOString() } });
      send(res as HostResponseLike, 303, { ...headers, location: "/__anywhere/" }, "");
      return;
    }

    if (path === "/__anywhere/api/link") {
      const created = createLink(now());
      const next = { ...current, link: nextLinkRecord(current.link, created.record) };
      await store.save(next);
      const target = config.relayUrl ? pairingUrl(config.relayUrl, created.link.token) : null;
      send(res as HostResponseLike, 200, { ...headers, "content-type": "application/json" }, JSON.stringify({ pairingUrl: target, expiresAt: created.record.expiresAt }));
      return;
    }

    const view = {
      configured: isConfigured(config),
      relayUrl: config.relayUrl,
      pairingUrl: null as string | null,
      connection:
        connection === "connected" ? ("已连接" as const) : connection === "reconnecting" ? ("重连中" as const) : ("未连接" as const),
      devices: current.devices.filter((d) => !d.revokedAt).map((d) => ({ label: d.label, lastSeenAt: d.lastSeenAt })),
      successCount: current.stats.success,
      failureCount: current.stats.failure,
    };
    send(res as HostResponseLike, 200, headers, renderStatusPage(view));
  });

  activeAdapter.registerRoute("prefix", "/p/", async (req, res) => {
    const path = requestPath(req as HostRequestLike);
    const current = await state();
    const outcome = handlePairing(path, current, { now: now() });
    if (outcome.nextState) await store.save(outcome.nextState);
    send(res as HostResponseLike, outcome.status, outcome.headers, outcome.body);
  });

  // 未匹配到配对路径的 /p/ 请求交回宿主
  void PAIRING_RE;

  tunnel?.start();
  return runtime;
}

export default function apply(host: PluginHost, rawConfig: unknown, options?: Partial<RuntimeOptions>): PluginRuntime {
  return createRuntime(host, rawConfig, {
    storageDir: options?.storageDir ?? "~/.dsh/storages/dsh-anywhere",
    createSocket: options?.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike),
    ...(options?.dshVersion ? { dshVersion: options.dshVersion } : {}),
    ...(options?.agentVersion ? { agentVersion: options.agentVersion } : {}),
  });
}
