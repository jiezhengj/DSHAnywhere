import { ERROR_CODES } from "./constants.ts";
import type { ErrorCode } from "./constants.ts";

export type { ErrorCode };
export { ERROR_CODES };

export type Visibility = "remote" | "desktop";

export interface ErrorSpec {
  code: ErrorCode;
  status: number;
  visibility: Visibility;
  title: string;
  hint: string;
}

export const ERROR_SPECS: Record<ErrorCode, ErrorSpec> = {
  "protocol": { code: "protocol", status: 400, visibility: "remote", title: "连接协议错误", hint: "请更新桌面端插件后重试。" },
  "protocol-version": { code: "protocol-version", status: 400, visibility: "remote", title: "版本不兼容", hint: "桌面端插件与本页面版本不一致，请更新后重试。" },
  "agent-not-connected": { code: "agent-not-connected", status: 503, visibility: "remote", title: "电脑端未运行", hint: "请确认桌面版 DeepSeek Harness 已启动并保持后台常驻。" },
  "agent-already-connected": { code: "agent-already-connected", status: 409, visibility: "remote", title: "电脑端已连接", hint: "同一台电脑只允许一个连接，请稍后重试。" },
  "backpressure": { code: "backpressure", status: 429, visibility: "remote", title: "数据积压", hint: "数据量过大，请稍后重试。" },
  "upstream-unreachable": { code: "upstream-unreachable", status: 502, visibility: "remote", title: "电脑端暂时无法响应", hint: "请检查桌面端进程是否卡住。" },
  "upstream-timeout": { code: "upstream-timeout", status: 504, visibility: "remote", title: "电脑端响应超时", hint: "请稍后重试或检查桌面端网络。" },
  "quota-exceeded": { code: "quota-exceeded", status: 503, visibility: "desktop", title: "中转额度已用尽或被限制", hint: "请在 Cloudflare 控制台查看当日用量。" },
  "stream-aborted": { code: "stream-aborted", status: 499, visibility: "remote", title: "连接已中断", hint: "正在自动重连，请稍后刷新。" },
};

/** 中转不可达：没有任何服务方能返回页面，只能由桌面端状态页呈现 */
export const RELAY_UNREACHABLE: ErrorSpec = {
  code: "upstream-unreachable",
  status: 0,
  visibility: "desktop",
  title: "中转不可达",
  hint: "请检查地址是否正确、Worker 是否已部署。",
};

export function errorSpec(code: ErrorCode): ErrorSpec {
  return ERROR_SPECS[code];
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** 渲染统一错误页；不含堆栈、内部路径或凭证 */
export function renderErrorPage(spec: ErrorSpec): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(spec.title)}</title>`,
    "</head><body>",
    `<main><h1>${escapeHtml(spec.title)}</h1><p>${escapeHtml(spec.hint)}</p></main>`,
    "</body></html>",
  ].join("");
}

export function errorResponse(code: ErrorCode): Response {
  const spec = errorSpec(code);
  return new Response(renderErrorPage(spec), {
    status: spec.status || 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
