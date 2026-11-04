# 契约：插件 ↔ 中转 帧协议（v1）

**Feature**: `001-browser-remote-access` | **版本**: `protocolVersion = 1`

本契约约束 `packages/plugin` 与 `packages/relay` 之间的全部通信。两侧共用 `@dsh-anywhere/protocol` 的常量与编解码实现，不得各自复制一份。

## 1. 传输与端点

| 项 | 值 |
| --- | --- |
| Agent 通道 | `wss://<relay-origin>/__dsh_agent?install=<installId>&v=1` |
| 浏览器通道 | `<relay-origin>` 下除 `/__dsh_agent` 外的所有路径 |
| 汇聚单元 | 每个 `installId` 对应一个 Durable Object 实例（`idFromName(installId)`） |
| 编码 | 二进制帧（`ArrayBuffer`）；控制类载荷为 UTF-8 JSON |
| 单帧上限 | 64 KiB 载荷（超过即发送方分片） |

## 2. 帧格式

```text
offset  size  field
0       1     version    （u8，v1 = 1）
1       1     type       （u8，见 §3）
2       2     flags      （u16 BE，保留，v1 全 0）
4       4     streamId   （u32 BE，0 保留给连接级控制帧）
8       4     length     （u32 BE，payload 字节数）
12      N     payload
```

- 头固定 12 字节。
- `streamId` 由发起方分配，单向递增，回收后不复用；HTTP 请求与 WS 会话各自独立计数。
- 解析失败（`version` 不认识、`length` 越界、`type` 未知）→ 接收方发送 `ERROR(0x60, code=protocol)` 并关闭连接，不做猜测性恢复。

## 3. 帧类型

| 值 | 名称 | 方向 | 载荷 |
| --- | --- | --- | --- |
| `0x01` | `AGENT_HELLO` | agent → relay | JSON：`{ installId, protocolVersion, agentVersion, dshVersion, capabilities[] }` |
| `0x02` | `RELAY_HELLO_ACK` | relay → agent | JSON：`{ protocolVersion, relayOrigin, region }` |
| `0x10` | `HTTP_REQUEST_HEAD` | relay → agent | JSON：`{ method, path, headers, bodyBytes? }` |
| `0x11` | `HTTP_REQUEST_BODY` | relay → agent | 原始字节分片 |
| `0x12` | `HTTP_REQUEST_END` | relay → agent | 空 |
| `0x20` | `HTTP_RESPONSE_HEAD` | agent → relay | JSON：`{ status, headers }` |
| `0x21` | `HTTP_RESPONSE_BODY` | agent → relay | 原始字节分片 |
| `0x22` | `HTTP_RESPONSE_END` | agent → relay | 空 |
| `0x30` | `WS_OPEN` | relay → agent | JSON：`{ path, headers, subprotocol? }` |
| `0x31` | `WS_OPEN_ACK` | agent → relay | JSON：`{ ok, status?, reason? }` |
| `0x32` | `WS_DATA` | 双向 | 原始字节；`flags` bit0 = 1 表示文本帧 |
| `0x33` | `WS_CLOSE` | 双向 | JSON：`{ code, reason }` |
| `0x40` | `FLOW_CREDIT` | 双向 | JSON：`{ bytes }`（该流新增可用窗口） |
| `0x50` | `PING` | 双向 | 空 |
| `0x51` | `PONG` | 双向 | 空 |
| `0x60` | `ERROR` | 双向 | JSON：`{ code, message, streamId? }` |

## 4. 握手

1. agent 建立 WSS，首帧必须是 `AGENT_HELLO`；relay 在 5 秒内未收到合法 hello 则关闭（`code=4001`）。
2. relay 校验 `protocolVersion`：不等于 1 → `ERROR(protocol-version)` 后关闭（`code=4002`），插件据此进入 `disabled` 并提示升级。
3. relay 回 `RELAY_HELLO_ACK`，其中 `relayOrigin` 是浏览器应使用的入口地址（插件据此生成二维码）。
4. 已有一个 agent 连接时，新连接以 `code=4003`（`agent-already-connected`）关闭——v1 一台电脑一个 agent。

## 5. HTTP 流生命周期

```text
relay                                    agent
  │ HTTP_REQUEST_HEAD(streamId=n)  ───────▶
  │ HTTP_REQUEST_BODY(×k)          ───────▶    （无请求体则跳过）
  │ HTTP_REQUEST_END               ───────▶
  │                                        └─▶ 转发到 127.0.0.1:<port>
  │ ◀─────── HTTP_RESPONSE_HEAD
  │ ◀─────── HTTP_RESPONSE_BODY(×m)
  │ ◀─────── HTTP_RESPONSE_END
  │ 流结束，streamId 回收
```

- 任一侧收到 `ERROR` 指向该 `streamId` → 立即终止该流，relay 向浏览器返回 502。
- agent 在 30 秒内未发出 `HTTP_RESPONSE_HEAD` → relay 回 504 并终止流（浏览器侧显示可重试提示）。

## 6. WS 流生命周期

```text
relay                                      agent
  │ WS_OPEN(streamId=n, path)     ──────────▶
  │ ◀────────────────────────── WS_OPEN_ACK
  │ ◀──────────────────────────▶ WS_DATA …
  │ ◀──────────────────────────▶ WS_CLOSE
```

- relay 只允许对 `/api/remote.mux` 发起 `WS_OPEN`；其它路径的 upgrade 一律 404（与 DSH 升级路由"精确匹配"行为一致）。
- `WS_OPEN_ACK(ok=false)` → relay 以 `status` 拒绝浏览器升级（401/403 由 agent 决定）。

## 7. 背压

- 每条流初始窗口 256 KiB。
- 发送方在该流「已发送未确认字节数」达到窗口时暂停；接收方处理完一批后回 `FLOW_CREDIT`。
- relay 侧窗口按 DO 内存预算分配（并发流 ≤ 8 时总窗口 ≤ 2 MiB），避免 128 MB 内存被单条流吃满。
- 接收方积压超过 2× 窗口 → 直接 `ERROR(backpressure)` 并终止流，不做无限缓冲。

## 8. 心跳与重连

- 任一侧空闲 25 秒发 `PING`；收到 `PING` 必须回 `PONG`。
- 连续 2 次心跳无响应（50 秒）→ 判定链路死亡，关闭并重建。
- 重连退避：0.5 s、1 s、2 s，封顶 5 s，抖动 ±20%；成功握手后清零。
- 重连不恢复旧流：所有在途 `streamId` 作废，relay 对进行中的浏览器请求返回 502（浏览器自行重试）。

## 9. 错误码

| code | 含义 | 插件行为 |
| --- | --- | --- |
| `protocol` | 帧不合法 | 关闭连接并记录 |
| `protocol-version` | 版本不匹配 | 进入 `disabled`，状态页提示升级 |
| `agent-already-connected` | 已有 agent | 退避重试，不升级为 `disabled` |
| `backpressure` | 流缓冲超限 | 终止该流并记一次失败 |
| `upstream-unreachable` | 本机 loopback 不可达 | 回 502 并提示"电脑端未运行" |
| `quota-exceeded` | 中转额度耗尽 | 回 503 并提示额度问题（FR-013） |

## 10. 版本演进

- 新增帧类型或字段：`protocolVersion` 不变，双方忽略未知字段。
- 破坏性变更（帧头改变、语义改变）：`protocolVersion` 升主版本，旧版本握手直接拒绝；仓库内 `.specify` 与 `docs/security.md` 需记录迁移说明（Constitution 开发工作流）。
