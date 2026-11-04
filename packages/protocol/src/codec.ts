import { HEADER_BYTES, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./constants.ts";
import { FrameType } from "./frames.ts";
import type { FrameTypeValue } from "./frames.ts";

export interface Frame {
  type: FrameTypeValue;
  streamId: number;
  flags: number;
  payload: Uint8Array;
}

export type ProtocolErrorCode = "bad-version" | "bad-length" | "unknown-type" | "truncated";

export class ProtocolError extends Error {
  override readonly name: string = "ProtocolError";
  readonly code: ProtocolErrorCode;

  constructor(message: string, code: ProtocolErrorCode) {
    super(message);
    this.code = code;
  }
}

const KNOWN_TYPES = new Set<number>(Object.values(FrameType));

/** 编码一帧；调用方负责保证 payload ≤ MAX_FRAME_BYTES。 */
export function encodeFrame(frame: Frame): Uint8Array {
  const { type, streamId, flags, payload } = frame;
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      `payload ${payload.byteLength} 超过单帧上限 ${MAX_FRAME_BYTES}`,
      "bad-length",
    );
  }
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, type);
  view.setUint16(2, flags, false);
  view.setUint32(4, streamId, false);
  view.setUint32(8, payload.byteLength, false);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** 解码一帧；任何越界或不认识的输入都抛 ProtocolError，不做猜测性恢复。 */
export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.byteLength < HEADER_BYTES) {
    throw new ProtocolError(`帧不足 ${HEADER_BYTES} 字节（实得 ${buf.byteLength}）`, "truncated");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`不认识的协议版本 ${version}`, "bad-version");
  }
  const type = view.getUint8(1);
  if (!KNOWN_TYPES.has(type)) {
    throw new ProtocolError(`未知帧类型 0x${type.toString(16)}`, "unknown-type");
  }
  const flags = view.getUint16(2, false);
  const streamId = view.getUint32(4, false);
  const length = view.getUint32(8, false);
  if (length > MAX_FRAME_BYTES) {
    throw new ProtocolError(`声明的载荷长度 ${length} 超过单帧上限`, "bad-length");
  }
  if (HEADER_BYTES + length > buf.byteLength) {
    throw new ProtocolError(
      `声明的载荷长度 ${length} 超出实际剩余 ${buf.byteLength - HEADER_BYTES}`,
      "truncated",
    );
  }
  const payload = buf.subarray(HEADER_BYTES, HEADER_BYTES + length);
  return { type: type as FrameTypeValue, streamId, flags, payload };
}

/** 控制类帧的 JSON 载荷编解码 */
export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}
