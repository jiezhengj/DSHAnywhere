# Phase 1 数据模型：DSHAnywhere 远程接入

**Feature**: `001-browser-remote-access` | **日期**: 2026-11-04 | **来源**: [spec.md](spec.md) 的「关键实体」与 FR-001~FR-028

本文件只描述插件侧需要持久化或维护状态的实体；中转侧（Worker/DO）**不持久化任何用户数据**，只有内存态会话与平台分配的实例身份。

## 实体总览

```text
┌──────────────┐        ┌───────────────┐        ┌──────────────┐
│ Installation │1─────1 │ RelayBinding  │        │  Connection  │(内存态)
│  安装实例    │        │  中转绑定     │        │   隧道连接   │
└──────┬───────┘        └───────────────┘        └──────────────┘
       │1
       │
       ├────n──▶ CapabilityLink（能力链接，短期、一次性）
       │
       ├────n──▶ Device（浏览器设备，长期、可撤销）
       │
       └────1──▶ AccessStats（访问计数，用于 SC-005）
```

## Installation（安装实例）

一次插件安装的根身份。v1 中一个 Installation 唯一对应一台电脑，且只绑定一台中转。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `installId` | `string` | 32 字节随机数的 base64url 编码，安装时生成一次，此后不变。协议中始终携带（FR-028） |
| `createdAt` | `string` (ISO 8601) | 生成时间 |
| `state` | `"provisioning" \| "ready" \| "disabled"` | `disabled` 表示版本探测不通过或被用户停用 |
| `disabledReason` | `string?` | 仅 `disabled` 时存在，用于状态页展示（FR-027） |
| `contractVersion` | `{ expected: string; actual: string }` | 最近一次探测结果 |

**不变量**：
- `installId` 全局唯一且在 Installation 生命周期内不可变；轮换与撤销**不得**改变它（否则中转侧路由会断）。
- `state = "disabled"` 时不得建立隧道、不得接受任何新配对。

## RelayBinding（中转绑定）

使用者填写的中转地址及其连接状态。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | `string` | 规范化后的 `https://` 源，仅保留 origin（FR-002 只要求填地址） |
| `status` | `"unconfigured" \| "connecting" \| "connected" \| "unreachable"` | 当前连接状态（FR-022） |
| `lastConnectedAt` | `string?` | 最近一次握手成功时间 |
| `encodedOrigin` | `string` | 首次连接中转时返回的对外入口地址（用于二维码，FR-004） |
| `protocolVersion` | `number` | 握手协商结果，v1 = 1 |
| `counter` | `{ day: string; requests: number }` | 当日计入中转的请求数（额度可见性，FR-024） |

**校验规则**：
- `url` 必须是 `https://` 且不含路径、查询串；本地 `http://127.0.0.1:<port>` 仅在开发模式下允许（见 `contracts/relay-http.md` 的 dev 例外）。
- 地址变更时保留设备表与 `installId`，只重建隧道。

## Device（浏览器设备）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 16 字节随机数的 base64url |
| `label` | `string` | 可辨识名称（由配对时的 `User-Agent` 归类为「iPhone / Android / 桌面浏览器」+ 序号）；用户可后续忽略 |
| `credentialHash` | `string` | 设备凭证的 SHA-256（十六进制）。明文只在配对响应中出现一次 |
| `createdAt` / `lastSeenAt` | `string` | 配对时间 / 最近一次成功访问时间 |
| `state` | `"active" \| "revoked"` | 撤销后保留记录 7 天以便状态页展示，随后清除 |
| `requestCount` | `number` | 该设备的累计成功请求数（用于 SC-005 的分子） |

**状态机**：

```text
（配对成功）──▶ active ──(用户撤销)──▶ revoked ──(7 天后)──▶ 记录清除
                  │
                  └──(长期无访问，凭证明文仍有效，不自动过期；用户可见 lastSeenAt)
```

**不变量**：
- `state = "revoked"` 的设备必须在下一个请求即被拒绝（无缓存延迟，FR-017/FR-018）。
- 设备凭证不得因密钥轮换而失效（FR-016 与 spec 假设第 7 条）。
- 至少保留 1 台 `active` 设备时，不得阻止用户撤销其它设备；撤销最后一台设备时需二次确认（避免把自己锁在外面）。

## CapabilityLink（能力链接）

一次性配对入口。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tokenHash` | `string` | 令牌的 SHA-256；明文只在生成时呈现一次 |
| `createdAt` | `string` | 生成时间 |
| `expiresAt` | `string` | `createdAt + 10 分钟`（澄清记录 1） |
| `state` | `"active" \| "consumed" \| "expired" \| "rotated"` | 生命周期 |
| `consumedBy` | `string?` | 被哪台设备消费（`Device.id`） |

**状态机**：

```text
生成 ──▶ active ──(配对成功)──▶ consumed
            ├──(超 10 分钟)──▶ expired
            └──(用户轮换)────▶ rotated
```

**不变量**：
- store 中最多保留 5 条历史链接记录，超出按时间淘汰；`active` 链接最多 1 条（生成新链接会先作废旧链接）。
- `expired` / `rotated` / `consumed` 一律按"无效"处理，对外响应不区分原因（FR-019）。

## Connection（隧道连接，内存态）

不落盘，进程重启即重建。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `state` | `"idle" \| "connecting" \| "connected" \| "reconnecting" \| "failed"` | 状态页映射到中文文案 |
| `attempt` | `number` | 当前重连次数，成功清零 |
| `nextRetryAt` | `string?` | 下次重试时间（退避 0.5→1→2→5 s，±20% 抖动） |
| `since` | `string` | 进入当前状态的时间 |
| `streams` | `Map<number, StreamState>` | 活跃流（HTTP 请求 id 或 WS id） |

**状态机**：

```text
idle ──▶ connecting ──(握手成功)──▶ connected
            │                          │
            │                     (链路断开)
            ▼                          ▼
          failed ◀──(超过 5 次失败)── reconnecting
```

**不变量**：`failed` 需要在状态页显示可定位原因（DNS/证书/401/版本不匹配 四类，对应 FR-013）。

## AccessStats（访问统计）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `window` | `{ since: string; success: number; failure: number }` | 滑动 24 小时窗口，用于计算 SC-005 的 ≥95% |
| `lastFailure` | `{ at: string; kind: string }?` | 最近一次失败分类 |

**不变量**：统计只记计数与分类，不记 URL、不记请求体、不记凭证（Constitution 安全约束）。

## 持久化文件布局

```text
~/.dsh/storages/dsh-anywhere/
├── state.json        # Installation / RelayBinding / Devices / Links / Stats（0600）
└── state.json.tmp    # 原子替换用临时文件
```

`state.json` 示例（字段裁剪）：

```json
{
  "schemaVersion": 1,
  "installation": {
    "installId": "<base64url>",
    "createdAt": "2026-11-04T12:00:00.000Z",
    "state": "ready",
    "contractVersion": { "expected": "0.2.x", "actual": "0.2.1-rc.5" }
  },
  "relay": {
    "url": "https://example-relay.example.workers.dev",
    "status": "connected",
    "lastConnectedAt": "2026-11-04T12:05:00.000Z",
    "protocolVersion": 1,
    "counter": { "day": "2026-11-04", "requests": 0 }
  },
  "devices": [],
  "links": [],
  "stats": { "window": { "since": "2026-11-04T12:00:00.000Z", "success": 0, "failure": 0 } }
}
```

**写入规则**：读取时校验 `schemaVersion`，遇到未知版本拒绝启动并提示；写入用 `fs.writeFile(tmp)` → `fs.rename()`；解析失败时把损坏文件改名为 `state.json.corrupt-<timestamp>` 并从空状态开始（不得静默丢弃凭据而不告知）。

## 与需求的对齐

| 需求 | 实体依据 |
| --- | --- |
| FR-004 / 澄清 1 | `CapabilityLink.expiresAt` = +10 分钟；`state` 四态 |
| FR-006 / SC-004 | `Device` 无过期字段，只有 `revoked` 才失效；`lastSeenAt` 可观测 |
| FR-007 / FR-008 | `devices[]` 多条目，`id` 独立寻址 |
| FR-016 | 轮换只改 `links`，不动 `devices` |
| FR-017 / FR-018 | 撤销即改 `state`，网关每次请求实时查表 |
| FR-022 | `RelayBinding.status` + `Connection.state` + `devices[]` |
| FR-024 / SC-005 | `AccessStats.window` 的成功/失败计数 |
| FR-027 | `Installation.state = "disabled"` + `disabledReason` |
| FR-028 | `Installation.installId` 出现在协议首帧 |
