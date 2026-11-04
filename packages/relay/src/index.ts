export { RelayObject } from "./relay-object.ts";
import { errorResponse } from "./errors.ts";

export interface RelayEnv {
  RELAY_OBJECT: DurableObjectNamespace;
  DSH_INSTALL_ID?: string;
}

/**
 * 判断是否为 WebSocket 升级请求。
 * 实测：Cloudflare Workers 会把 `Upgrade` 头剥掉，只留下 `connection: Upgrade`
 * 与 `sec-websocket-*`，所以不能只认 `upgrade`。
 */
export function isWebSocketUpgrade(request: Request): boolean {
  const headers = request.headers;
  return (
    headers.get("x-dsh-upgrade") === "1" ||
    headers.get("sec-websocket-key") !== null ||
    (headers.get("connection") ?? "").toLowerCase().includes("upgrade") ||
    (headers.get("upgrade") ?? "").toLowerCase() === "websocket"
  );
}

/** 允许透传给 agent 的 WebSocket 路径：v1 只有实时通道 */
export const WS_PASSTHROUGH_PATHS = new Set(["/api/remote.mux"]);

export function isAllowedUpgrade(pathname: string): boolean {
  return WS_PASSTHROUGH_PATHS.has(pathname);
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 必须剥离的头：平台痕迹会破坏 DSH 的同源判断 */
const DROP_PREFIXES = ["cf-", "x-forwarded-", "x-real-ip"];

const KEEP_HEADERS = new Set(["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]);

function shouldDrop(name: string): boolean {
  const lower = name.toLowerCase();
  if (KEEP_HEADERS.has(lower)) return false;
  if (HOP_BY_HOP.has(lower)) return true;
  if (lower === "sec-fetch-site" || lower === "sec-fetch-mode" || lower === "sec-fetch-dest") return true;
  return DROP_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** 清理转发头，保留业务所需字段 */
export function sanitizeRequestHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    if (!shouldDrop(name)) out.set(name, value);
  });
  return out;
}

export function resolveInstallId(url: URL, env: RelayEnv): string {
  return url.searchParams.get("install") ?? env.DSH_INSTALL_ID ?? "default";
}

/** Worker 入口路由（T016）：agent 通道、健康检查、其余转 DO */
export async function handleRequest(request: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/__relay/health") {
    return Response.json({ ok: true, protocolVersion: 1 });
  }

  const upgrade = isWebSocketUpgrade(request);
  const isAgent = url.pathname === "/__dsh_agent";
  if (isAgent && !upgrade) {
    return errorResponse("protocol");
  }
  // 未列入白名单的升级请求直接 404：DSH 的升级路由只做精确匹配
  if (upgrade && !isAgent && !isAllowedUpgrade(url.pathname)) {
    return new Response("not found", { status: 404 });
  }

  const installId = resolveInstallId(url, env);
  const stub = env.RELAY_OBJECT.get(env.RELAY_OBJECT.idFromName(installId));

  // 升级请求必须原样转交：重新包装 Request 会丢失升级语义（实测 1006）
  if (upgrade) return stub.fetch(request);

  const forwarded = new Request(request.url, {
    method: request.method,
    headers: sanitizeRequestHeaders(request.headers),
    body: request.body,
    redirect: "manual",
  });
  forwarded.headers.set("x-dsh-install", installId);
  forwarded.headers.set("x-dsh-agent", isAgent ? "1" : "0");

  return stub.fetch(forwarded);
}

export default {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
