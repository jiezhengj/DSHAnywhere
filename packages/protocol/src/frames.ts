import { MAX_FRAME_BYTES } from "./constants.ts";
/** 帧类型；取值见 contracts/agent-protocol.md §3 */
export const FrameType = {
  AGENT_HELLO: 0x01,
  RELAY_HELLO_ACK: 0x02,
  HTTP_REQUEST_HEAD: 0x10,
  HTTP_REQUEST_BODY: 0x11,
  HTTP_REQUEST_END: 0x12,
  HTTP_RESPONSE_HEAD: 0x20,
  HTTP_RESPONSE_BODY: 0x21,
  HTTP_RESPONSE_END: 0x22,
  WS_OPEN: 0x30,
  WS_OPEN_ACK: 0x31,
  WS_DATA: 0x32,
  WS_CLOSE: 0x33,
  FLOW_CREDIT: 0x40,
  PING: 0x50,
  PONG: 0x51,
  ERROR: 0x60,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** 帧头 flags 位定义 */
export const FrameFlags = {
  /** WS_DATA：payload 为 UTF-8 文本帧 */
  WS_TEXT: 1 << 0,
  /** WS_DATA：还有后续分片，接收方需要累积后再交付给 WebSocket */
  WS_MORE: 1 << 1,
} as const;

/** 一条 WebSocket 消息在协议层被切成多少个 ≤ MAX_FRAME_BYTES 的分片 */
export function wsFragmentSizes(total: number, max = MAX_FRAME_BYTES): number[] {
  const sizes: number[] = [];
  let left = total;
  while (left > 0) {
    const size = Math.min(left, max);
    sizes.push(size);
    left -= size;
  }
  return sizes.length > 0 ? sizes : [0];
}

export interface AgentHello {
  installId: string;
  protocolVersion: number;
  agentVersion: string;
  dshVersion: string;
  capabilities: string[];
}

export interface RelayHelloAck {
  protocolVersion: number;
  relayOrigin: string;
  region?: string;
}

export interface HttpRequestHead {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBytes?: number;
}

export interface HttpResponseHead {
  status: number;
  headers: Record<string, string>;
}

export interface WsOpen {
  path: string;
  headers: Record<string, string>;
  subprotocol?: string;
}

export interface WsOpenAck {
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface WsClose {
  code: number;
  reason: string;
}

export interface FlowCredit {
  bytes: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
  streamId?: number;
}
