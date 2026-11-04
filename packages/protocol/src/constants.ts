/** 帧协议版本；与 contracts/agent-protocol.md 保持一致 */
export const PROTOCOL_VERSION = 1;

/** 固定帧头长度（字节） */
export const HEADER_BYTES = 12;

/** 单帧载荷上限（字节）；超过由发送方分片 */
export const MAX_FRAME_BYTES = 65_536;

/** 单流窗口（字节） */
export const WINDOW_BYTES = 262_144;

/** 心跳间隔（毫秒） */
export const HEARTBEAT_MS = 25_000;

/** 握手超时（毫秒）：relay 未在此时间内收到合法 hello 即关闭 */
export const HELLO_TIMEOUT_MS = 5_000;

/** 单次请求等待 agent 响应的上限（毫秒） */
export const REQUEST_TIMEOUT_MS = 30_000;

/** WebSocket 关闭码 */
export const CLOSE_CODES = {
  helloTimeout: 4001,
  protocolVersion: 4002,
  agentAlreadyConnected: 4003,
  protocolError: 4004,
} as const;

/** 错误帧中的 code 取值 */
export const ERROR_CODES = [
  "protocol",
  "protocol-version",
  "agent-not-connected",
  "agent-already-connected",
  "backpressure",
  "upstream-unreachable",
  "upstream-timeout",
  "quota-exceeded",
  "stream-aborted",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 重连退避序列（毫秒），带 ±20% 抖动 */
export const BACKOFF_MS = [500, 1_000, 2_000, 5_000] as const;
