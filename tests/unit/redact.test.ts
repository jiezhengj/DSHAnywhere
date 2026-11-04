import { test } from "node:test";
import assert from "node:assert/strict";
import { redactHeaders, redactSecrets, redactUrl } from "../../packages/plugin/src/redact.ts";
import { renderErrorPage, errorSpec } from "../../packages/protocol/src/index.ts";
import { buildStatusPayload } from "../../packages/plugin/src/status.ts";
import { createDevice } from "../../packages/plugin/src/devices.ts";
import { createLink, nextLinkRecord } from "../../packages/plugin/src/link.ts";
import { emptyState } from "../../packages/plugin/src/store.ts";

const TOKEN = "A".repeat(43);

test("配对路径中的令牌被掩去", () => {
  const out = redactUrl(`https://relay.example/p/${TOKEN}`);
  assert.ok(!out.includes(TOKEN));
  assert.ok(out.includes("[已隐去]"));
});

test("查询串中的凭证被掩去", () => {
  const out = redactUrl("https://relay.example/?token=abc123&x=1");
  assert.ok(!out.includes("abc123"));
  assert.ok(out.includes("x=1"));
});

test("cookie 头整体被掩去，其余头保留", () => {
  const out = redactHeaders({
    Cookie: "__Host-dshanywhere=secret",
    "set-cookie": "a=b",
    "content-type": "text/html",
  });
  assert.equal(out.Cookie, "[已隐去]");
  assert.equal(out["set-cookie"], "[已隐去]");
  assert.equal(out["content-type"], "text/html");
});

test("任意文本中的 43 位高熵串被掩去", () => {
  const out = redactSecrets(`token=${TOKEN} done`);
  assert.ok(!out.includes(TOKEN));
});

test("普通文本不受影响", () => {
  const text = "电脑端未运行：请确认桌面版已启动";
  assert.equal(redactSecrets(text), text);
});

test("错误页不包含任何令牌或凭证", () => {
  const { credential } = createDevice("iPhone", 1_000);
  const html = renderErrorPage({ ...errorSpec("stream-aborted") });
  assert.equal(html.includes(credential), false);
  assert.equal(/(token|credential)=[A-Za-z0-9_-]{20,}/.test(html), false);
});

test("状态载荷不返回凭证摘要或链接令牌摘要", () => {
  const { device, credential } = createDevice("iPhone", 1_000);
  const { link, record } = createLink(1_000);
  const payload = JSON.stringify(
    buildStatusPayload({
      state: { ...emptyState(), devices: [device], link: nextLinkRecord(null, record) },
      relayUrl: "https://relay.example",
      connection: "connected",
      relayOrigin: "https://relay.example",
      installId: "abc",
      contractVersion: { expected: "0.2.x", actual: "0.2.1-rc.5" },
      now: () => 1_000,
      secure: true,
    }),
  );
  assert.equal(payload.includes(credential), false);
  assert.equal(payload.includes(record.tokenHash), false);
  assert.equal(payload.includes(link.token), false);
});

test("日志脱敏覆盖 token 查询参数与 Cookie 头", () => {
  const url = redactUrl("https://relay.example/p/abcdefghijklmnopqrstuvwxyz012345?token=SECRET1234567890");
  assert.equal(url.includes("SECRET1234567890"), false);
  const headers = redactHeaders({ cookie: "__Host-dshanywhere=SECRET1234567890", accept: "text/html" });
  assert.equal(JSON.stringify(headers).includes("SECRET1234567890"), false);
  assert.equal(headers["accept"], "text/html");
});
