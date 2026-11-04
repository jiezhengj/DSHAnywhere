import { verifyCredential } from "./devices.ts";
import { BROWSER_COOKIE } from "./rewrite.ts";
import type { Device, StoreState } from "./store.ts";

export type AuthFailure = "unpaired" | "disabled";

export type AuthResult = { ok: true; device: Device } | { ok: false; reason: AuthFailure };

/**
 * 每个请求都实时查表：撤销立即生效，不做任何凭证缓存。
 * 这是 FR-016「撤销 1 分钟内生效」的实现基础。
 */
export function authenticate(state: StoreState, credential: string | null): AuthResult {
  if (!state.enabled) return { ok: false, reason: "disabled" };
  if (!credential) return { ok: false, reason: "unpaired" };
  const device = verifyCredential(state, credential);
  return device ? { ok: true, device } : { ok: false, reason: "unpaired" };
}

export interface CookieOptions {
  secure: boolean;
  maxAgeDays?: number;
}

/** 下发设备凭证 cookie：__Host- 前缀要求 Secure + Path=/ + 无 Domain */
export function deviceCookie(credential: string, options: CookieOptions): string {
  const parts = [
    `${BROWSER_COOKIE}=${credential}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (options.secure) parts.push("Secure");
  if (options.maxAgeDays !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeDays * 86400)}`);
  return parts.join("; ");
}

/** 从 Cookie 头里取指定名字的值；不存在返回 null */
export function readCookie(headers: Record<string, string>, name: string): string | null {
  const raw = headers["cookie"];
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export interface RotateResult {
  state: StoreState;
  revokedLinks: number;
  devicesUnaffected: number;
}

/** 轮换：递增 linkEpoch、作废未使用链接，不动设备表 */
export function rotateLinks(state: StoreState, now: number = Date.now()): RotateResult {
  const revokedLinks = state.link !== null && state.link.expiresAt > now ? 1 : 0;
  return {
    state: { ...state, link: null, linkEpoch: state.linkEpoch + 1 },
    revokedLinks,
    devicesUnaffected: state.devices.filter((d) => !d.revokedAt).length,
  };
}

export function setEnabled(state: StoreState, enabled: boolean): StoreState {
  return { ...state, enabled };
}

export function recordSuccess(state: StoreState, deviceId: string, now: Date = new Date()): StoreState {
  const devices = state.devices.map((d) =>
    d.id === deviceId ? { ...d, lastSeenAt: now.toISOString(), requestCount: (d.requestCount ?? 0) + 1 } : d,
  );
  return {
    ...state,
    devices,
    stats: { ...state.stats, success: state.stats.success + 1, lastSuccessAt: now.toISOString() },
  };
}

export function recordFailure(state: StoreState): StoreState {
  return { ...state, stats: { ...state.stats, failure: state.stats.failure + 1 } };
}

export function availability(stats: StoreState["stats"]): number {
  const total = stats.success + stats.failure;
  return total === 0 ? 1 : Number((stats.success / total).toFixed(3));
}
