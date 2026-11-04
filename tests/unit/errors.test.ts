import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, errorSpec, renderErrorPage, RELAY_UNREACHABLE } from "../../packages/plugin/src/errors.ts";

test("所有错误码都有文案与状态码", () => {
  for (const code of ERROR_CODES) {
    const spec = errorSpec(code);
    assert.equal(spec.code, code);
    assert.ok(spec.title.length > 0);
    assert.ok(spec.hint.length > 0);
  }
});

test("额度耗尽与中转不可达只在桌面端可见", () => {
  assert.equal(errorSpec("quota-exceeded").visibility, "desktop");
  assert.equal(RELAY_UNREACHABLE.visibility, "desktop");
  assert.equal(errorSpec("agent-not-connected").visibility, "remote");
});

test("错误页不含堆栈且带 no-referrer", () => {
  const html = renderErrorPage(errorSpec("agent-not-connected"));
  assert.ok(html.includes("电脑端未运行"));
  assert.ok(html.includes('name="referrer" content="no-referrer"'));
  assert.ok(!/at .*:\d+:\d+/.test(html));
});

test("错误页转义用户可见文本", () => {
  const html = renderErrorPage({ ...errorSpec("protocol"), title: '<script>x</script>' });
  assert.ok(!html.includes("<script>x"));
  assert.ok(html.includes("&lt;script&gt;"));
});
