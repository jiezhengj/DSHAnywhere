import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "../../packages/protocol/src/index.ts";

test("协议版本常量为 1", () => {
  assert.equal(PROTOCOL_VERSION, 1);
});
