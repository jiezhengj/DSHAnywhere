import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_SPECS, renderErrorPage } from "../../packages/protocol/src/index.ts";

test("远端可渲染的四类故障都在 remote 表面", () => {
  const remote = ["agent-not-connected", "stream-aborted", "upstream-timeout", "protocol-version"] as const;
  for (const code of remote) assert.equal(ERROR_SPECS[code].visibility, "remote", code);
});

test("中转不可达与额度受限只应出现在桌面端", () => {
  assert.equal(ERROR_SPECS["quota-exceeded"].visibility, "desktop");
  assert.equal(ERROR_SPECS["upstream-unreachable"].visibility, "remote");
});

test("每个错误码都能渲染成完整页面", () => {
  for (const code of Object.keys(ERROR_SPECS) as (keyof typeof ERROR_SPECS)[]) {
    const html = renderErrorPage(ERROR_SPECS[code]);
    assert.match(html, /<!doctype html>/i, code);
    assert.match(html, new RegExp(ERROR_SPECS[code].title), code);
    assert.equal(html.includes("undefined"), false, code);
  }
});

test("凭证无效与链接无效的文案互不相同", () => {
  const unpaired = renderErrorPage(ERROR_SPECS["agent-not-connected"]);
  assert.notEqual(unpaired, renderErrorPage(ERROR_SPECS["stream-aborted"]));
});
