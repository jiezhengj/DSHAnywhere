import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowWindow, splitPayload } from "../../packages/plugin/src/flow.ts";

test("空载荷不分片", () => {
  assert.deepEqual(splitPayload(new Uint8Array()), []);
});

test("小于上限时保持单帧", () => {
  assert.equal(splitPayload(new Uint8Array(100), 65536).length, 1);
});

test("超过上限时按 64 KiB 切分且拼接后与原数据一致", () => {
  const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
  const chunks = splitPayload(bytes);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0]?.byteLength, 65536);
  assert.equal(chunks[3]?.byteLength, 200_000 - 65536 * 3);
  const joined = new Uint8Array(200_000);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  assert.deepEqual(joined, bytes);
});

test("消耗窗口后 available 递减，grant 后回补", () => {
  const w = new FlowWindow(1000);
  w.consume(600);
  assert.equal(w.available, 400);
  assert.equal(w.suggestCredit, 600);
  w.grant(600);
  assert.equal(w.available, 1000);
});

test("grant 不越过窗口上限", () => {
  const w = new FlowWindow(1000);
  w.consume(900);
  w.grant(500);
  assert.equal(w.available, 600);
  w.grant(500);
  assert.equal(w.available, 1000);
});

test("耗尽标记在归零时成立", () => {
  const w = new FlowWindow(100);
  w.consume(100);
  assert.equal(w.exhausted, true);
  assert.equal(w.available, 0);
});

test("消耗超过窗口时不出现负值", () => {
  const w = new FlowWindow(100);
  w.consume(500);
  assert.equal(w.available, 0);
});
