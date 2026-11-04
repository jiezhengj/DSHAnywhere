import { MAX_FRAME_BYTES, WINDOW_BYTES } from "../../protocol/src/index.ts";

/** 把一段字节切成不超过单帧上限的分片；空输入返回空数组 */
export function splitPayload(bytes: Uint8Array, maxFrameBytes: number = MAX_FRAME_BYTES): Uint8Array[] {
  if (bytes.byteLength === 0) return [];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maxFrameBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + maxFrameBytes, bytes.byteLength)));
  }
  return chunks;
}

/**
 * 发送侧窗口：每发出一片就消耗窗口；窗口耗尽或低于一半时暂停，等待对端
 * 发来 FLOW_CREDIT 后由 grant() 补充。接收侧（中转）负责发出授权。
 */
export class FlowWindow {
  readonly #total: number;
  #available: number;

  constructor(total: number = WINDOW_BYTES) {
    this.#total = total;
    this.#available = total;
  }

  get available(): number {
    return this.#available;
  }

  get total(): number {
    return this.#total;
  }

  consume(bytes: number): void {
    this.#available = Math.max(0, this.#available - bytes);
  }

  grant(bytes: number): void {
    this.#available = Math.min(this.#total, this.#available + bytes);
  }

  /** 窗口耗尽：此时应暂停发送等待 FLOW_CREDIT */
  get exhausted(): boolean {
    return this.#available <= 0;
  }

  /** 低于一半时建议对端补充的字节数（收发两侧共用此口径） */
  get suggestCredit(): number {
    return this.#available <= this.#total / 2 ? this.#total - this.#available : 0;
  }
}
