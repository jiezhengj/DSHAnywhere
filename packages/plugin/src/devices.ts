import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Device, StoreState } from "./store.ts";

export const MAX_DEVICES = 10;
export const DEVICE_BYTES = 32;

export function hashCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("base64url");
}

export interface CreatedDevice {
  device: Device;
  credential: string;
}

/** 生成设备凭证：明文只返回这一次，存储里只留摘要 */
export function createDevice(label: string, now: number = Date.now()): CreatedDevice {
  const credential = randomBytes(DEVICE_BYTES).toString("base64url");
  const device: Device = {
    id: randomUUID(),
    label,
    credentialHash: hashCredential(credential),
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  };
  return { device, credential };
}

export function activeDevices(state: StoreState): Device[] {
  return state.devices.filter((d) => !d.revokedAt);
}

export function canPairAnotherDevice(state: StoreState, max = MAX_DEVICES): boolean {
  return activeDevices(state).length < max;
}

/** 校验设备凭证：撤销过的设备一律拒绝 */
export function verifyCredential(state: StoreState, credential: string): Device | null {
  const digest = hashCredential(credential);
  const found = state.devices.find((d) => d.credentialHash === digest && !d.revokedAt);
  return found ?? null;
}

export function touchDevice(state: StoreState, deviceId: string, now: number = Date.now()): void {
  const device = state.devices.find((d) => d.id === deviceId);
  if (device) device.lastSeenAt = new Date(now).toISOString();
}

export function revokeDevice(state: StoreState, deviceId: string, now: number = Date.now()): boolean {
  const device = state.devices.find((d) => d.id === deviceId);
  if (!device || device.revokedAt) return false;
  device.revokedAt = new Date(now).toISOString();
  return true;
}

export function deviceLabel(index: number): string {
  return `设备 ${index + 1}`;
}
