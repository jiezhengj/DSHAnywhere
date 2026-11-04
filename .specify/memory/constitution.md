# DSHAnywhere Constitution

## Core Principles

### I. 原生边界（Native Boundary）

插件只做接入：入口地址、认证、隧道转发、状态与设备管理。

- 插件 MUST NOT 修改 DSH 的权限模型、会话状态、原生 UI 能力，或改变其认证与信任栅栏的语义。
- 远程会话的行为 MUST 与本地完全一致；不得引入 DSH 原生不存在的模式（例如"只读观察""远程权限降级"）。
- 需要与 DSH 内部契约交互时，只能做等价转发，不得借机改变其语义。

理由：插件的价值来自"把原生能力接到浏览器"，任何行为改变都会让远程与本地不一致，并放大上游升级带来的破坏面。

### II. 作者零基础设施（Author-Free Infrastructure）

仓库与运行时不依赖作者提供的任何服务器、域名、账号或凭据。

- 代码与配置 MUST NOT 内置作者端点、默认中转域名、作者 API Token 或任何作者凭据。
- 中转 MUST 由使用者自行部署（v1 为 Cloudflare Worker；后续 VPS/NAS），作者不提供托管服务。
- 任何时候 MUST NOT 把使用者流量引向作者的资源。

理由：分发要能自我维持，避免成本、隐私与单点责任集中到作者身上。

### III. 双端零安装（Zero-Install on Both Ends）

- 浏览器端 MUST 只需浏览器：不安装客户端、浏览器扩展或 VPN。
- PC 端 MUST 除插件本身外不要求安装或运行额外客户端；需要用户执行的外部动作（如部署中转）必须压缩为文档加一条命令。
- MUST NOT 把 Tailscale、cloudflared、ngrok 等需要用户单独安装的客户端作为必需路径。

理由：安装摩擦是这类工具最常见的弃用原因；零安装是需求的核心约束，不是优化项。

### IV. 可撤销的能力链接（Capability Link with Revocation）

v1 以高熵能力链接作为唯一凭证。

- 密钥 MUST 为 256 位随机值；MUST NOT 写入日志、错误信息、统计上报或任何外部服务。
- 系统 MUST 提供密钥轮换（旧链接立即失效）与单设备撤销，且两者在 1 分钟内生效。
- 传输 MUST 为 HTTPS/WSS；cookie MUST 为 HttpOnly、SameSite=Strict、Secure；响应 MUST 携带 `Referrer-Policy: no-referrer`。

理由：在"不做密码/TOTP"的决定下，撤销与轮换是泄露后唯一的止损手段，属于首版必备而非后续优化。

### V. 本地优先与最小暴露（Local-First, Minimal Exposure）

- 插件 MUST 默认只监听 loopback；对外暴露 MUST 仅通过使用者自己的中转、以出站连接建立。
- MUST NOT 默认要求公网 IP、端口映射、域名或路由器配置。
- 无效或过期的凭证 MUST 一律拒绝，响应不得泄露内部结构或 DSH 细节。

理由：暴露面越小、默认配置越少，越不容易出现"装好了但不敢用"的状态。

## 额外约束

技术约束：

- v1 的唯一中转是 Cloudflare Worker（Free 计划）；设计 MUST 假定 Durable Objects 额度与 WebSocket 帧上限存在，大消息走普通 HTTP 旁路。
- 会话 MUST 留在桌面 Host 进程内；MUST NOT 另起 Host 试图驱动同一会话（单写者租约）。
- 与 DSH 内部契约的交互 MUST 集中在单一适配层，并在启动时探测版本；不兼容时 MUST 禁用远程入口并给出明确提示，不得静默降级。
- 协议 MUST 预留安装 ID 字段；v1 实现单台电脑 + 多台浏览器设备，不得假设多台电脑。
- 优先纯 Node 实现，MUST NOT 引入需要单独安装的原生二进制作为必需依赖。

安全约束：

- 中转 MUST NOT 记录请求正文、密钥或会话内容。
- 插件日志默认 MUST NOT 包含带密钥的 URL。
- 密钥轮换与设备撤销 MUST 在 UI 中可直接操作，不依赖命令行。

## 开发工作流

- 本项目使用 Spec Kit 的 Feature SDD；涉及安全边界、协议或架构的改动走完整路径（specify → clarify → plan → checklist → tasks → analyze → implement → converge）。
- 每个 Feature 的验收标准 MUST 覆盖 `problem.md` 中定义的成功指标（首次可用时间、日常零操作、断线恢复、可访问率、止损时间）。
- 插件版本与中转版本 MUST 做握手校验；破坏性协议变更升主版本号并写迁移说明。
- 提交前 MUST 完成：单元测试、本机端到端（本机 → Worker → 手机浏览器）验证、以及对本 Constitution 的逐条自检。
- 发布物通过 `dsh plugin --profile <name> add <pkg>` 安装；文档语言为简体中文，命令与标识符保留原文。

## Governance

- 本 Constitution 优先于其他项目约定；与之冲突的做法 MUST 修改或记录显式例外及理由。
- 修订 MUST 记录在案、按语义化版本升版（MAJOR：移除或重定义原则；MINOR：新增原则或章节；PATCH：措辞澄清），并说明影响。
- 每个 Feature 的 plan 与 analyze 阶段 MUST 核对本 Constitution；无法满足时 MUST 在计划中显式说明并取得批准。
- 运行时开发指引以项目 `AGENTS.md` 为准；两者冲突时以本 Constitution 的原则为准。

**Version**: 1.0.0 | **Ratified**: 2026-11-04 | **Last Amended**: 2026-11-04
