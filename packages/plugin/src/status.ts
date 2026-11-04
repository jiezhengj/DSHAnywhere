import { availability, recordFailure, recordSuccess, rotateLinks, setEnabled } from "./auth.ts";
import { createDevice, revokeDevice, MAX_DEVICES } from "./devices.ts";
import { createLink, nextLinkRecord } from "./link.ts";
import { normalizeRelayUrl, pairingUrl } from "./relay-url.ts";
import type { StoreState } from "./store.ts";
import type { TunnelStatus } from "./agent.ts";

export interface StatusContext {
  state: StoreState;
  relayUrl: string | null;
  connection: TunnelStatus;
  relayOrigin: string | null;
  installId: string;
  contractVersion: { expected: string; actual: string };
  now: () => number;
  secure: boolean;
}

export type ApiEffect = "rebuild-tunnel" | "stop-tunnel" | "start-tunnel";

export interface ApiResult {
  status: number;
  body: string;
  nextState?: StoreState;
  effect?: ApiEffect;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(value: unknown, status = 200): ApiResult {
  return { status, body: JSON.stringify(value) };
}

function fail(code: string, status = 400, message?: string): ApiResult {
  return json({ ok: false, error: { code, ...(message ? { message } : {}) } }, status);
}

function deviceState(state: StoreState, deviceId: string): "active" | "revoked" {
  const device = state.devices.find((d) => d.id === deviceId);
  return device?.revokedAt ? "revoked" : "active";
}

export function buildStatusPayload(ctx: StatusContext): Record<string, unknown> {
  const { state } = ctx;
  const active = state.devices.filter((d) => !d.revokedAt);
  return {
    installation: {
      installId: ctx.installId,
      state: state.relay ? "ready" : "unconfigured",
      contractVersion: ctx.contractVersion,
    },
    relay: {
      url: state.relay?.url ?? null,
      status: ctx.connection,
      lastConnectedAt: state.relay?.connectedAt ?? null,
      requestsToday: state.stats.success,
    },
    connection: { state: ctx.connection, since: state.stats.since, attempt: 0 },
    devices: state.devices.map((d) => ({
      id: d.id,
      label: d.label,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      state: d.revokedAt ? "revoked" : "active",
      requestCount: d.requestCount ?? 0,
    })),
    activeLink: state.link ? { expiresAt: new Date(state.link.expiresAt).toISOString(), consumed: false } : null,
    stats: {
      window: {
        since: state.stats.since,
        success: state.stats.success,
        failure: state.stats.failure,
        availability: availability(state.stats),
      },
    },
    warnings: [],
    limits: { maxDevices: MAX_DEVICES, activeDevices: active.length },
  };
}

/**
 * 状态 API：所有写操作都在这里集中处理，返回需要持久化的新状态与副作用，
 * 由调用方（index.ts）落盘并重建隧道。这样接口层不直接操作运行时。
 */
export function handleStatusApi(
  method: string,
  path: string,
  rawBody: string,
  ctx: StatusContext,
): ApiResult {
  const { state } = ctx;
  const isWrite = method === "POST";

  if (path === "/__anywhere/api/status" && method === "GET") {
    return json(buildStatusPayload(ctx));
  }

  if (path === "/__anywhere/api/relay" && isWrite) {
    const input = parseBody(rawBody);
    const candidate = input["url"] ?? input["relayUrl"];
    const normalised = normalizeRelayUrl(candidate);
    if (!normalised.ok) return fail("invalid-url", 400, normalised.detail);
    return {
      status: 200,
      body: JSON.stringify({ ok: true }),
      nextState: {
        ...state,
        relay: { url: normalised.origin, connectedAt: new Date(ctx.now()).toISOString() },
      },
      effect: "rebuild-tunnel",
    };
  }

  if (path === "/__anywhere/api/link" && isWrite) {
    const base = ctx.relayUrl ?? state.relay?.url ?? null;
    if (!base) return fail("relay-not-configured", 409, "请先配置中转地址");
    const created = createLink(ctx.now());
    return {
      status: 200,
      body: JSON.stringify({
        ok: true,
        pairUrl: pairingUrl(base, created.link.token),
        expiresAt: new Date(created.record.expiresAt).toISOString(),
      }),
      nextState: { ...state, link: nextLinkRecord(state.link, created.record) },
    };
  }

  if (path === "/__anywhere/api/rotate" && isWrite) {
    const rotated = rotateLinks(state, ctx.now());
    return {
      status: 200,
      body: JSON.stringify({
        ok: true,
        revokedLinks: rotated.revokedLinks,
        devicesUnaffected: rotated.devicesUnaffected,
      }),
      nextState: rotated.state,
    };
  }

  const revokeMatch = /^\/__anywhere\/api\/devices\/([^/]+)\/revoke$/.exec(path);
  if (revokeMatch && isWrite) {
    const deviceId = decodeURIComponent(revokeMatch[1] ?? "");
    const next = structuredClone(state);
    if (!revokeDevice(next, deviceId, ctx.now())) return fail("not-found", 404);
    const remaining = next.devices.filter((d) => !d.revokedAt).length;
    return {
      status: 200,
      body: JSON.stringify(remaining === 0 ? { ok: true, warning: "no-active-device" } : { ok: true }),
      nextState: next,
    };
  }

  if (path === "/__anywhere/api/enable" && isWrite) {
    return { status: 200, body: JSON.stringify({ ok: true }), nextState: setEnabled(state, true), effect: "start-tunnel" };
  }
  if (path === "/__anywhere/api/disable" && isWrite) {
    return { status: 200, body: JSON.stringify({ ok: true }), nextState: setEnabled(state, false), effect: "stop-tunnel" };
  }

  if (path === "/__anywhere/api/devices" && method === "POST") {
    const input = parseBody(rawBody);
    const label = typeof input["label"] === "string" ? input["label"] : `设备 ${state.devices.length + 1}`;
    const created = createDevice(label, ctx.now());
    return {
      status: 200,
      body: JSON.stringify({ ok: true, device: { id: created.device.id, label: created.device.label } }),
      nextState: { ...state, devices: [...state.devices, created.device] },
    };
  }

  if (path.startsWith("/__anywhere/api/")) {
    return fail("not-found", 404);
  }
  return fail("not-found", 404);
}

function parseBody(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const form = new URLSearchParams(trimmed);
  return Object.fromEntries(form.entries());
}

export { JSON_HEADERS, deviceState, recordFailure, recordSuccess };
