import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DEVICES,
  activeDevices,
  canPairAnotherDevice,
  createDevice,
  deviceLabel,
  revokeDevice,
  verifyCredential,
} from "../../packages/plugin/src/devices.ts";
import { emptyState } from "../../packages/plugin/src/store.ts";

test("设备凭证为 32 字节且只存摘要", () => {
  const { device, credential } = createDevice("iPhone", 1_000);
  assert.equal(Buffer.from(credential, "base64url").byteLength, 32);
  assert.equal(device.credentialHash.length > 0, true);
  assert.equal(JSON.stringify(device).includes(credential), false);
});

test("正确凭证可校验，错误凭证与伪造 token 被拒", () => {
  const { device, credential } = createDevice("iPhone", 1_000);
  const state = { ...emptyState(), devices: [device] };
  assert.ok(verifyCredential(state, credential));
  assert.equal(verifyCredential(state, "wrong"), null);
  assert.equal(verifyCredential(state, ""), null);
  const tampered = (credential[0] === "A" ? "B" : "A") + credential.slice(1);
  assert.equal(verifyCredential(state, tampered), null);
});

test("两条相同 label 的设备 id 不同", () => {
  const a = createDevice("设备 1", 1_000);
  const b = createDevice("设备 1", 1_000);
  assert.notEqual(a.device.id, b.device.id);
});

test("撤销后立即无法校验且不占名额", () => {
  const { device, credential } = createDevice("iPhone", 1_000);
  const state = { ...emptyState(), devices: [device] };
  assert.equal(revokeDevice(state, device.id, 2_000), true);
  assert.equal(verifyCredential(state, credential), null);
  assert.equal(activeDevices(state).length, 0);
  assert.equal(state.devices[0]?.revokedAt?.startsWith("1970-01-01"), true);
});

test("重复撤销返回 false", () => {
  const { device } = createDevice("iPhone", 1_000);
  const state = { ...emptyState(), devices: [device] };
  revokeDevice(state, device.id, 2_000);
  assert.equal(revokeDevice(state, device.id, 3_000), false);
});

test("撤销不存在的设备返回 false", () => {
  const state = emptyState();
  assert.equal(revokeDevice(state, "nope", 1_000), false);
});

test("设备上限为 10 台，撤销腾出名额", () => {
  assert.equal(MAX_DEVICES, 10);
  const devices = Array.from({ length: 10 }, (_, i) => createDevice(deviceLabel(i), 1_000).device);
  const state = { ...emptyState(), devices };
  assert.equal(canPairAnotherDevice(state), false);
  revokeDevice(state, devices[0]!.id, 2_000);
  assert.equal(canPairAnotherDevice(state), true);
});

test("撤销记录保留（用于 7 天审计）", () => {
  const { device } = createDevice("iPhone", 1_000);
  const state = { ...emptyState(), devices: [device] };
  revokeDevice(state, device.id, 2_000);
  assert.equal(state.devices.length, 1);
  assert.ok(state.devices[0]?.revokedAt);
});
