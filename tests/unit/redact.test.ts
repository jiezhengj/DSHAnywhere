import { test } from "node:test";
import assert from "node:assert/strict";
import { redactHeaders, redactSecrets, redactUrl } from "../../packages/plugin/src/redact.ts";

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
