import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error 浏览器侧零依赖脚本，无类型声明
import { encodeQr, encodeQrWithMask, rsEncode, rsSyndromes } from "../../packages/plugin/ui/qr.js";

const URL_SAMPLE = "https://relay.example/p/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("RS 校验码字满足校验子全零", () => {
  const cases = [
    [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec],
    Array.from({ length: 68 }, (_, i) => (i * 37) % 256),
  ];
  for (const data of cases) {
    const ecc = rsEncode(data, 15);
    const syndromes = rsSyndromes([...data, ...ecc], 15);
    assert.deepEqual(syndromes, new Array(15).fill(0));
  }
});

test("矩阵尺寸随内容增长且为 4v+17", () => {
  const small = encodeQr("hi");
  assert.equal(small.length, 21); // v1
  const big = encodeQr(URL_SAMPLE);
  assert.equal((big.length - 17) % 4, 0);
  assert.ok(big.length >= 21);
});

test("三个定位图形位置正确且内部为 3x3 实心", () => {
  const m = encodeQr(URL_SAMPLE);
  const size = m.length;
  const check = (top: number, left: number) => {
    for (let i = 0; i < 7; i += 1) {
      assert.equal(m[top][left + i], true, "上边应全黑");
      assert.equal(m[top + 6][left + i], true, "下边应全黑");
      assert.equal(m[top + i][left], true, "左边应全黑");
      assert.equal(m[top + i][left + 6], true, "右边应全黑");
    }
    for (let r = 2; r <= 4; r += 1) for (let c = 2; c <= 4; c += 1) assert.equal(m[top + r][left + c], true);
    assert.equal(m[top + 1][left + 1], false);
  };
  check(0, 0);
  check(0, size - 7);
  check(size - 7, 0);
});

test("时序图形黑白交替", () => {
  const m = encodeQr(URL_SAMPLE);
  const size = m.length;
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(m[6][i], i % 2 === 0, `第 6 行第 ${i} 列`);
    assert.equal(m[i][6], i % 2 === 0, `第 6 列第 ${i} 行`);
  }
});

test("固定暗模块存在", () => {
  const m = encodeQr(URL_SAMPLE);
  assert.equal(m[m.length - 8][8], true);
});

test("矩阵没有未填充的模块", () => {
  const m = encodeQr(URL_SAMPLE);
  for (const row of m) for (const cell of row) assert.equal(typeof cell, "boolean");
});

test("不同掩码产生不同矩阵但都能生成", () => {
  const a = encodeQrWithMask(URL_SAMPLE, 0);
  const b = encodeQrWithMask(URL_SAMPLE, 1);
  assert.notDeepEqual(a, b);
  assert.equal(a.length, b.length);
});

test("超出容量时报错而不是静默截断", () => {
  assert.throws(() => encodeQr("x".repeat(200)), /内容过长/);
});
