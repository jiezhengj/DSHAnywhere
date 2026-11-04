export type RelayUrlResult =
  | { ok: true; url: string; origin: string }
  | { ok: false; code: "invalid-url"; detail: string };

/**
 * 规范化使用者填入的中转地址：
 * 只接受 https（本机调试允许 http://localhost / http://127.0.0.1），
 * 不允许路径、查询串与片段，末尾斜杠归一。
 */
export function normalizeRelayUrl(input: unknown): RelayUrlResult {
  if (typeof input !== "string") {
    return { ok: false, code: "invalid-url", detail: "中转地址必须是字符串" };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "invalid-url", detail: "中转地址不能为空" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: "invalid-url", detail: "不是合法的 URL" };
  }

  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    return { ok: false, code: "invalid-url", detail: "必须是 https 地址（本机调试可用 localhost）" };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { ok: false, code: "invalid-url", detail: "地址不能带路径，请只填协议与主机名" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, code: "invalid-url", detail: "地址不能带查询串或片段" };
  }

  const origin = `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  return { ok: true, url: `${origin}/`, origin };
}

/** 配对入口：中转地址 + 能力链接令牌 */
export function pairingUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/p/${token}`;
}
