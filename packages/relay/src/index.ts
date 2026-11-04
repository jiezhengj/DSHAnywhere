import { errorResponse } from "./errors.ts";

export interface RelayEnv {
  RELAY_OBJECT: DurableObjectNamespace;
  DSH_INSTALL_ID?: string;
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

function shouldDrop(name: string): boolean {
  const lower = name.toLowerCase();
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

  const isAgent = url.pathname === "/__dsh_agent";
  if (isAgent && request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse("protocol");
  }

  const installId = resolveInstallId(url, env);
  const stub = env.RELAY_OBJECT.get(env.RELAY_OBJECT.idFromName(installId));

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
