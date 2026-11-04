import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LINK_TTL_MS,
  consumeLink,
  createLink,
  hashToken,
  nextLinkRecord,
} from "../../packages/plugin/src/link.ts";

test("链接为 32 字节随机且只存摘要", () => {
  const { link, record } = createLink(1_000);
  assert.equal(Buffer.from(link.token, "base64url").byteLength, 32);
  assert.equal(record.tokenHash, hashToken(link.token));
  assert.notEqual(record.tokenHash, link.token);
});

test("10 分钟内有效，超时即失效", () => {
  const { link, record } = createLink(1_000);
  assert.equal(consumeLink(record, link.token, 1_000 + LINK_TTL_MS - 1).ok, true);
  const expired = consumeLink(record, link.token, 1_000 + LINK_TTL_MS);
  assert.equal(expired.ok, false);
});

test("错误令牌被拒", () => {
  const { record } = createLink(1_000);
  assert.equal(consumeLink(record, "wrong-token", 2_000).ok, false);
});

test("没有链接时一律拒绝", () => {
  assert.equal(consumeLink(null, "anything", 0).ok, false);
});

test("消费后移除记录，第二次使用失败（一次性）", () => {
  const { link, record } = createLink(1_000);
  assert.equal(consumeLink(record, link.token, 1_000).ok, true);
  assert.equal(consumeLink(null, link.token, 1_000).ok, false);
});

test("并发两个请求只有一个赢家", () => {
  const { link, record } = createLink(1_000);
  const first = consumeLink(record, link.token, 1_000);
  const second = consumeLink(null, link.token, 1_000);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
});

test("新链接替换旧链接并递增 epoch", () => {
  const a = createLink(0);
  const b = createLink(10);
  const recA = nextLinkRecord(null, a.record);
  const recB = nextLinkRecord(recA, b.record);
  assert.equal(recB.epoch, 2);
  assert.equal(recB.tokenHash, b.record.tokenHash);
});

test("每次生成的令牌不同", () => {
  const a = createLink(0).link.token;
  const b = createLink(0).link.token;
  assert.notEqual(a, b);
});
