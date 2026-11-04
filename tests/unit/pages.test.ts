import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusPage } from "../../packages/plugin/src/pages.ts";

const base = {
  configured: true,
  relayUrl: "https://relay.example",
  pairingUrl: null,
  connection: "已连接" as const,
  devices: [],
  successCount: 0,
  failureCount: 0,
};

test("未配置时给出部署命令与文档链接", () => {
  const html = renderStatusPage({ ...base, configured: false, relayUrl: null, connection: "未连接" });
  assert.match(html, /npx wrangler deploy/);
  assert.match(html, /docs\/relay-setup\.md/);
  assert.match(html, /还没有中转/);
});

test("已配置时显示连接状态与入口地址", () => {
  const html = renderStatusPage(base);
  assert.match(html, /已连接/);
  assert.match(html, /https:\/\/relay\.example/);
});

test("有配对链接时渲染二维码画布与脚本", () => {
  const html = renderStatusPage({ ...base, pairingUrl: "https://relay.example/p/abc" });
  assert.match(html, /<canvas id="qr"/);
  assert.match(html, /qr\.js/);
});

test("设备列表与可访问率被渲染", () => {
  const html = renderStatusPage({
    ...base,
    devices: [{ label: "设备 1", lastSeenAt: "2026-11-04T10:00:00.000Z" }],
    successCount: 12,
    failureCount: 1,
  });
  assert.match(html, /设备 1/);
  assert.match(html, /12 成功/);
});

test("页面包含 no-referrer 且无外部资源", () => {
  const html = renderStatusPage(base);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(html, /https?:\/\/(?!github\.com)[a-z0-9.-]+\/.*\.(js|css)/i);
});

test("桌面端区分中转不可达与额度限制（FR-013）", () => {
  const unreachable = renderStatusPage({ ...base, relayFailure: "unreachable" });
  const quota = renderStatusPage({ ...base, relayFailure: "quota" });
  assert.match(unreachable, /中转不可达/);
  assert.match(quota, /额度已用尽/);
  assert.notEqual(unreachable, quota);
});

test("正常状态下不渲染故障横幅", () => {
  assert.doesNotMatch(renderStatusPage(base), /中转不可达/);
});
