import { renderErrorPage, errorSpec } from "./errors.ts";

export interface StatusView {
  configured: boolean;
  relayUrl: string | null;
  pairingUrl: string | null;
  connection: "未连接" | "重连中" | "已连接";
  devices: { id?: string; label: string; lastSeenAt: string }[];
  successCount: number;
  failureCount: number;
}

const DEPLOY_COMMAND = "npx wrangler deploy --config relay/wrangler.toml";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 未配置中转时的引导：集中给出文档位置与完整命令（FR-001） */
function unconfiguredSection(): string {
  return [
    "<section>",
    "<h2>还没有中转</h2>",
    "<ol>",
    "<li>在自己的 Cloudflare 账号下部署中转（免费计划即可）：",
    `<pre><code>${escapeHtml(DEPLOY_COMMAND)}</code></pre>`,
    "</li>",
    "<li>部署完成后会得到一个 <code>https://&lt;name&gt;.workers.dev</code> 地址。</li>",
    "<li>把该地址填到下方并保存。</li>",
    "</ol>",
    '<p>完整步骤见 <a href="https://github.com/deepseek-ai/dsh-anywhere/blob/main/docs/relay-setup.md">docs/relay-setup.md</a>。</p>',
    '<form method="post" action="/__anywhere/api/relay">',
    '<label for="relay">中转地址</label>',
    '<input id="relay" name="relayUrl" type="url" placeholder="https://example.workers.dev" required>',
    '<button type="submit">保存</button>',
    "</form>",
    "</section>",
  ].join("");
}

function configuredSection(view: StatusView): string {
  const devices = view.devices.length
    ? view.devices
        .map(
          (d) =>
            `<li>${escapeHtml(d.label)} · 最近访问 ${escapeHtml(d.lastSeenAt)}` +
            ` <button type="button" data-revoke="${escapeHtml(d.id ?? "")}">撤销</button></li>`,
        )
        .join("")
    : "<li>还没有已配对的设备</li>";

  return [
    "<section>",
    `<p>中转连接：<strong>${escapeHtml(view.connection)}</strong></p>`,
    `<p>入口地址：<code>${escapeHtml(view.relayUrl ?? "")}</code></p>`,
    '<div id="pairing-block">',
    view.pairingUrl
      ? `<p>配对链接：<code class="pairing">${escapeHtml(view.pairingUrl)}</code></p>`
      : '<p id="pairing-hint">点下方按钮生成一次性配对链接（10 分钟内有效、只能用一次）。</p>',
    '<canvas id="qr" width="200" height="200"></canvas>',
    '<button type="button" id="generate-link">生成配对链接</button>',
    "</div>",
    '<div class="actions">',
    '<button type="button" id="rotate">轮换链接</button>',
    '<button type="button" id="disable">关闭远程接入</button>',
    "</div>",
    `<p>可访问率：${view.successCount} 成功 / ${view.failureCount} 失败</p>`,
    "<h2>已配对设备</h2>",
    `<ul id="devices">${devices}</ul>`,
    '<script src="/__anywhere/ui/qr.js"></script>',
    '<script src="/__anywhere/ui/ui.js"></script>',
    "</section>",
  ].join("");
}

/** 本机管理页；只有 loopback 可达，远端入口不暴露它 */
export function renderStatusPage(view: StatusView): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    "<title>DSHAnywhere 远程接入</title>",
    "</head><body>",
    "<main><h1>远程接入</h1>",
    view.configured ? configuredSection(view) : unconfiguredSection(),
    "</main></body></html>",
  ].join("");
}

/** 统一措辞：不区分从未存在 / 已过期 / 已被撤销（FR-004 / FR-019） */
export function renderLinkInvalidPage(): string {
  return renderErrorPage({
    ...errorSpec("protocol"),
    status: 401,
    title: "链接无效或已过期",
    hint: "请在电脑端重新生成配对链接。",
  });
}

export function renderTooManyDevicesPage(max: number): string {
  return renderErrorPage({
    ...errorSpec("protocol"),
    status: 403,
    title: "设备数量已达上限",
    hint: `同一台电脑最多配对 ${max} 台设备，请先在电脑端撤销不需要的设备。`,
  });
}

/** 清 cookie / 隐私模式下的统一提示：与「链接无效」区分开（T049） */
export function renderUnauthorizedPage(): string {
  return renderErrorPage({
    ...errorSpec("protocol"),
    status: 401,
    title: "这台设备还没有配对",
    hint: "请回到电脑端重新生成配对链接；如果刚清理过浏览器数据，重新扫一次码即可。",
  });
}

export function renderDisabledPage(): string {
  return renderErrorPage({
    ...errorSpec("protocol"),
    status: 503,
    title: "远程接入已关闭",
    hint: "请在电脑端的「远程接入」页面重新开启。",
  });
}
