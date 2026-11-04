# Implementation Plan: DSHAnywhere 浏览器远程接入

**Branch**: `001-browser-remote-access` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-browser-remote-access/spec.md`

## Summary

在桌面版 DSH 的 Host 进程内挂一个 Cordis 插件，主动出站连接使用者自建的 Cloudflare Worker 中转；浏览器经该 Worker 的固定 `*.workers.dev` 地址访问到本机原生 WebUI。采用「网关（插件）+ 隧道（出站 WSS）+ 中转（Worker + Durable Object）」三层，认证与凭证完全由插件持有，中转只做帧转发，不解析正文、不接触任何凭证。

技术要点来自本机实证：DSH 的浏览器端全部实时流量收敛在单一升级端点 `/api/remote.mux`，其余走 `/api` 前缀 HTTP 路由；浏览器认证是 `GET /?token=…` 换发的、绑定 `hostname:port` 的签名 cookie；信任栅栏校验 `Host`/`Origin`。因此网关只需做一件事：把远端请求改写为对 `127.0.0.1:<port>` 的等价本地请求，并注入一次换发好的 host cookie。

## Technical Context

**Language/Version**: TypeScript 5.6（`strict`），运行时为 DSH 桌面版内嵌 Node（本机 v26.0.0，最低支持 Node 22）

**Primary Dependencies**: 运行时零第三方依赖——插件侧只用 Node 内置 `fetch`、全局 `WebSocket`、`node:crypto`、`node:http`；中转侧只用平台运行时（`WebSocketPair`、Durable Objects）。开发期依赖：`typescript`、`wrangler`（仅部署/本地联调）、`@deepseek-ai/cordis`（peer，由宿主提供）

**Storage**: 插件侧 `~/.dsh/storages/dsh-anywhere/state.json`（安装 ID、密钥、设备表、访问计数；含密钥字段，权限 0600）；中转侧无持久业务数据，Durable Object 仅用其内存态与 hibernation，不落用户内容

**Testing**: `node:test`（插件核心逻辑、帧编解码、凭证生命周期、栅栏改写）；`wrangler dev`/miniflare 跑中转本地集成；本机端到端用脚本驱动（临时 Host + 本地中转 + 无头浏览器）

**Target Platform**: DSH 桌面版（Electron 主进程内的 Node Host，macOS/Windows/Linux）+ Cloudflare Workers/DO（Free 计划）

**Project Type**: monorepo，含「宿主插件」与「可部署中转」两个交付物

**Performance Goals**: 首屏与交互时延以 POC 实测基线为准（SC 未设硬阈值）；单条 WebSocket 消息上行 ≤ 64 KiB 分片；空闲时每分钟心跳 ≤ 2 次

**Constraints**: Worker Free 100,000 请求/日、10 ms CPU/调用、128 MB、6 个并发出站连接；DO Free 1,000,000 请求/月、5 GB 存储、单条消息 32 MiB；不得引入原生二进制；不得新开监听端口（复用 DSH 现有 loopback listener）

**Scale/Scope**: 单使用者、单电脑（1 个插件实例）、1 台中转、≤ 10 台已配对浏览器设备、并发设备 ≤ 3

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 / 约束 | 计划如何满足 | 结论 |
| --- | --- | --- |
| I. 原生边界 | 不修改任何 DSH 包与源码；只使用宿主公开的插件扩展点（`webServer.register/registerUpgrade/registerFallback/tapIndex`、`connection.authenticatedUrl`）。远端请求一律改写为 loopback 等价请求后交给 DSH 自己处理，不复制、不重放、不改变其语义。不引入只读模式或降级。 | PASS |
| II. 作者零基础设施 | 插件不含任何默认中转地址、作者 Token 或作者域名；中转代码随仓库分发、由使用者部署到自己的账号；`relay/` 中无作者资源标识。SC-009 可据此验证。 | PASS |
| III. 双端零安装 | 浏览器侧只有 cookie；PC 侧只装插件包；中转部署为 `npx wrangler deploy`（无需预装客户端，也不落地常驻进程）。文档中不出现 Tailscale/cloudflared/ngrok 作为必需路径。 | PASS |
| IV. 可撤销的能力链接 | 能力链接为 32 字节随机数；存储仅存 SHA-256 摘要；日志与错误信息不含凭证（统一拦截与脱敏）。轮换/撤销在内存态生效，无 TTL 缓存 → 1 分钟内必然生效。浏览器凭证为 `__Host-` 前缀 cookie，`HttpOnly; Secure; SameSite=Strict`；所有响应带 `Referrer-Policy: no-referrer`。 | PASS |
| V. 本地优先与最小暴露 | 不新开端口：网关寄生在 DSH 已有 loopback listener 上；对外路径只有一条出站 WSS。无公网 IP、无端口映射、无域名要求。无效/过期凭证一律返回同一个 401 页面，不区分原因。 | PASS |
| 技术约束：单适配层 + 版本探测 | 所有对 DSH 内部契约的引用集中在 `packages/plugin/src/adapter.ts`；启动时探测契约版本，不匹配则禁用远程入口并在状态页给出提示（不静默降级）。 | PASS |
| 技术约束：预留安装 ID | 协议 v1 每帧会话携带 `installId`；中转按 `installId` 派生 DO 实例；v1 只允许 1 个，多电脑留待 v2。 | PASS |
| 技术约束：纯 Node | 无原生模块、无子进程二进制；隧道用全局 `WebSocket`，中转部署用 `npx`。 | PASS |
| 安全约束：中转不落地正文 | Worker/DO 只在内存中按帧转发，不写 `console.log` 请求体，不启用 Analytics Engine 的上报字段。 | PASS |
| 安全约束：UI 可操作 | 轮换与撤销在本地管理页完成（按钮 + 确认），不依赖命令行。 | PASS |
| 开发工作流 | 走完整路径；验收覆盖 spec 的 SC-001~SC-010；插件与中转握手校验 `protocolVersion`。 | PASS |

**Gate 结论**：无违反项，无需 Complexity Tracking 中的例外记录。

## Project Structure

### Documentation (this feature)

```text
specs/001-browser-remote-access/
├── plan.md              # 本文件
├── research.md          # Phase 0：技术决策与证据
├── data-model.md        # Phase 1：实体与状态机
├── quickstart.md        # Phase 1：端到端验证指南
├── contracts/           # Phase 1：协议与接口契约
│   ├── agent-protocol.md
│   ├── relay-http.md
│   ├── dsh-adapter.md
│   └── status-api.md
└── tasks.md             # Phase 2 产出（$speckit-tasks 生成）
```

### Source Code (repository root)

```text
package.json                    # npm workspace 根
tsconfig.base.json
packages/
├── protocol/                   # @dsh-anywhere/protocol：帧编解码与共享类型
│   ├── src/{frames.ts,codec.ts,constants.ts,index.ts}
│   └── package.json
├── plugin/                     # @dsh-anywhere/plugin：Cordis 宿主插件（交付物 1）
│   ├── src/
│   │   ├── index.ts            # 插件入口：装配、生命周期、停用/启用
│   │   ├── adapter.ts          # 唯一接触 DSH 内部契约处；对外只暴露 4 个包装
│   │   ├── config.ts           # 配置 schema 与首次启动状态
│   │   ├── relay-url.ts        # 中转地址规范化与校验
│   │   ├── agent.ts            # 出站 WSS 隧道、握手、心跳、退避重连
│   │   ├── gateway.ts          # 帧 → loopback HTTP/WS 转发、栅栏改写、分片背压
│   │   ├── auth.ts             # 设备凭证签发/校验、链接轮换
│   │   ├── link.ts             # 能力链接生成/消费/过期
│   │   ├── devices.ts          # 设备表（≤10 台）与撤销
│   │   ├── stats.ts            # 访问计数与可访问率
│   │   ├── pages.ts            # 面向浏览器的错误与提示页
│   │   ├── status.ts           # 管理页路由与状态 API（经 adapter 注册）
│   │   ├── errors.ts           # 统一错误码
│   │   ├── store.ts            # state.json 读写、原子落盘、0600 权限
│   │   └── version.ts          # 契约版本探测
│   ├── ui/                     # 管理页（纯 HTML/CSS/JS，无构建步骤；含 qr.js）
│   └── package.json
└── relay/                      # @dsh-anywhere/relay：Worker + DO（交付物 2）
    ├── src/{index.ts,relay-object.ts,errors.ts}
    ├── wrangler.toml
    └── package.json
tests/
├── unit/                       # node:test：编解码、认证、栅栏改写、存储
├── integration/                # wrangler dev 下的中转 + 真实 Host 端到端脚本
└── fixtures/
docs/                           # 面向使用者的简体中文文档
├── install.md                  # 装插件 + 首次配对与日常使用
├── relay-setup.md              # 建立中转（一条命令）
├── security.md                 # 威胁模型、凭证模型、轮换与撤销
└── poc-findings.md             # POC 实测数字与验收记录（实现期产物）
scripts/
└── install.mjs                 # 一键安装（仅当补丁层无法自动写入时启用）
```

**Structure Decision**: 选单仓 monorepo（Option 1 变体），因为本特性有两个必须一起发布的交付物：插件（随 DSH 安装）与中转（随使用者部署）。`protocol` 单独成包，确保两端对帧格式与版本常量只有一份真源；`wrangler.toml` 与 Worker 源码放在 `relay/`，使"部署一条命令"能直接指向仓库内目录，使用者也无需理解插件代码。

## 远程访问链路

```text
浏览器 ──HTTPS/WSS──▶ Cloudflare Worker ──Durable Object──▶ 出站 WSS 隧道 ◀── 插件（桌面 Host 内）
   │                        (只转发帧)                              │
   └──────────── 固定地址 https://<worker>.workers.dev ─────────────┘
                                                                    └─▶ 127.0.0.1:<port> 原生 WebUI
```

- **中转侧**：Worker 的 `fetch` 处理所有路径；`/__dsh_agent` 升级给 DO 作为 agent 通道，其余请求按 `installId` 路由到同一 DO；DO 用 hibernatable WebSocket 同时持有 agent 与浏览器连接，按流 ID 多路复用。
- **插件侧**：`agent.ts` 维持出站 WSS；收到帧后由 `gateway.ts` 还原成对 `getOrigin()` 的 HTTP 请求（或对 `/api/remote.mux` 的本地 WS），注入 host cookie、改写栅栏头，把响应按帧送回。
- **认证**：能力链接只在插件侧校验；校验通过由插件下发 `__Host-dshanywhere` 设备 cookie；中转全程不接触凭证。

## Phases

### Phase 0：Outline & Research

产出 [research.md](research.md)，消解以下未知项：

1. Cloudflare Workers/DO Free 计划的真实额度与 WebSocket 消息上限（已验证并记录来源）；
2. 是否需要 Durable Object，以及不用的替代方案为何不成立；
3. 认证归属（插件侧 vs 中转侧）的取舍；
4. 与 DSH 内部契约的对接面，以及 `/api/remote.mux` 单一升级端点带来的一处简化；
5. 大消息分片与背压策略；
6. 中转部署形态与唯一一条命令；
7. 代理下静态资源与 index 注入的待验证项；
8. 断线重连、心跳与状态恢复；
9. 版本兼容探测；
10. 插件安装方式与 profile 补丁层插入是否可自动化（待验证项，含失败回退）。

### Phase 1：Design & Contracts

产出 [data-model.md](data-model.md)、[contracts/](contracts/)、[quickstart.md](quickstart.md)：

- `contracts/agent-protocol.md`：插件 ↔ 中转的帧协议、握手、版本、心跳、重连、背压；
- `contracts/relay-http.md`：浏览器 ↔ 中转的路径映射、状态码、错误页、cookie 与响应头策略；
- `contracts/dsh-adapter.md`：适配层用到的 DSH 契约、栅栏改写规则、cookie 换发、探测与降级；
- `contracts/status-api.md`：本地管理页接口（状态、设备列表、轮换、撤销、生成链接）。

### Phase 2（不在本阶段产出）

`$speckit-tasks` 依据上述产物生成 `tasks.md`。POC 验证项（额度边界、代理下资源路径、版本探测口径）将作为前置任务出现在其中。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Worker Free 额度触顶（10 万请求/日） | 远程入口硬失败 | 网关合并小请求、静态资源经中转缓存；状态页显示当日计数；触顶时给出可定位提示（FR-013） |
| 单条消息或内存超限 | 大历史/附件场景中断 | 64 KiB 分片 + 背压；超限快速失败并可重试 |
| DSH 内部契约变更 | 插件失效 | 所有接触面集中在 `adapter.ts`；启动探测版本；不兼容即禁用并提示（FR-027） |
| 中转地址被重新部署后变化 | 插件连不上 | 状态页明确"中转不可达"，引导重新填写地址；不静默重试到超时 |
| 无认证模型下的链接泄露 | 他人获得控制权 | 能力链接 10 分钟有效 + 轮换 + 设备撤销（FR-015~FR-019）；所有响应 no-referrer |
| 插件安装需手动改补丁层 | 首次可用时间超 10 分钟 | 文档给两条命令；验证 `dsh plugin add` 能否自动插入，不能则在 POC 后改走一键脚本 |

## Complexity Tracking

无 Constitution 违反项，本表留空。
