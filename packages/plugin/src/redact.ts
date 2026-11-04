const MASK = "[已隐去]";

/** 掩去 URL 中的能力链接令牌与查询串凭证 */
export function redactUrl(input: string): string {
  return input
    .replace(/\/p\/[A-Za-z0-9_-]{8,}/g, `/p/${MASK}`)
    .replace(/([?&](?:token|code|auth|key)=)[^&#]+/gi, `$1${MASK}`)
    .replace(/__Host-dshanywhere=[^;\s]+/g, `__Host-dshanywhere=${MASK}`);
}

const SENSITIVE_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "x-dsh-token",
  "x-relay-token",
]);

/** 掩去敏感请求/响应头 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? MASK : redactUrl(value);
  }
  return out;
}

/** 掩去任意文本中形如 32 字节高熵随机值（base64url 43 位）的片段 */
export function redactSecrets(text: string): string {
  return redactUrl(text).replace(/\b[A-Za-z0-9_-]{43}\b/g, MASK);
}
