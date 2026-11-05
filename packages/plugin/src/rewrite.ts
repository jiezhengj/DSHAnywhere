/** 宿主 cookie 的浏览器侧名字；转发到 loopback 前必须移除 */
export const BROWSER_COOKIE = "__Host-dshanywhere";

const DROP_PREFIXES = ["cf-", "x-forwarded-", "x-real-ip"];
const DROP_EXACT = new Set([
  // WebSocket 握手由客户端自己生成：把浏览器的这些头转过去会造成重复键、握手失败
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "connection",
  "upgrade",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "host",
  "origin",
  "referer",
  "cookie",
]);

export interface RewriteOptions {
  /** loopback origin，如 http://127.0.0.1:50743 */
  loopbackOrigin: string;
  /** 宿主自身的会话 cookie，形如 dsh-auth-x=... */
  hostCookie: string;
}

/**
 * 把浏览器请求头改写成 loopback 能接受的形式：
 * Host/Origin/Referer 指向 loopback，Cookie 换成宿主会话 cookie，
 * 丢弃平台痕迹与浏览器侧的跨站标记。
 */
export function rewriteRequestHeaders(
  input: Record<string, string>,
  options: RewriteOptions,
): Record<string, string> {
  const url = new URL(options.loopbackOrigin);
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (DROP_EXACT.has(lower)) continue;
    if (DROP_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    out[lower] = value;
  }

  out["host"] = url.host;
  out["origin"] = options.loopbackOrigin;
  const referer = input["referer"] ?? input["Referer"];
  if (referer) out["referer"] = options.loopbackOrigin;
  out["cookie"] = options.hostCookie;
  return out;
}

/** 上游响应的 Set-Cookie 必须丢弃：loopback 的会话 cookie 不能泄露给浏览器 */
export function filterResponseHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower === "set-cookie2") continue;
    if (lower === "transfer-encoding" || lower === "connection") continue;
    // fetch 已经把响应体解压过了：再把这个头透给浏览器，浏览器会拿明文当 gzip 解，
    // 模块脚本直接解析失败 —— 远程打开时整页空白就是这么来的。
    if (lower === "content-encoding" || lower === "content-length") continue;
    out[lower] = value;
  }
  return out;
}

/** 把 loopback 相对路径解析成绝对 URL；已是绝对 URL 的原样返回 */
export function toAbsoluteUrl(path: string, loopbackOrigin: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = loopbackOrigin.replace(/\/$/, "");
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}
