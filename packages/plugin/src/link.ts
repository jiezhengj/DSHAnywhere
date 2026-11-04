import { createHash, randomBytes } from "node:crypto";

export const LINK_TTL_MS = 10 * 60 * 1000;
export const LINK_BYTES = 32;

export interface CapabilityLink {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

export interface LinkRecord {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  epoch: number;
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: "invalid" };

/** 只存摘要：状态文件里不出现明文令牌 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

/** 生成一次性能力链接；32 字节随机，10 分钟有效 */
export function createLink(now: number = Date.now()): { link: CapabilityLink; record: LinkRecord } {
  const token = randomBytes(LINK_BYTES).toString("base64url");
  const expiresAt = now + LINK_TTL_MS;
  return {
    link: { token, tokenHash: hashToken(token), expiresAt },
    record: { tokenHash: hashToken(token), createdAt: now, expiresAt, epoch: 0 },
  };
}

/**
 * 一次性消费：令牌有效且未过期才通过。
 * 调用方必须在通过后立即把该链接从存储中移除，从而保证并发时有且只有一个赢家。
 */
export function consumeLink(record: LinkRecord | null, token: string, now: number = Date.now()): ConsumeResult {
  if (!record) return { ok: false, reason: "invalid" };
  if (now >= record.expiresAt) return { ok: false, reason: "invalid" };
  const candidate = hashToken(token);
  if (candidate.length !== record.tokenHash.length) return { ok: false, reason: "invalid" };
  // 定时安全比较：长度相同后逐字节比较
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ record.tokenHash.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: "invalid" };
}

/** 同一时刻只保留一条可用链接：新链接直接替换旧的 */
export function nextLinkRecord(previous: LinkRecord | null, next: LinkRecord): LinkRecord {
  return { ...next, epoch: (previous?.epoch ?? 0) + 1 };
}
