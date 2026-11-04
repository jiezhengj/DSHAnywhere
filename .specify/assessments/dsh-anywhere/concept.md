# Concept: 桌面会话的浏览器远程入口

- **Slug**: dsh-anywhere
- **创建时间**: 2026-11-04
- **推荐选项**: Option A — Worker 中转直通

## 方案选项

### Option A — Worker 中转直通（推荐）

- **方案轮廓**：插件在桌面 Host 内挂一个网关，主动出站连接使用者自己的 Cloudflare Worker；Worker 提供固定的 `*.workers.dev` 地址。手机浏览器打开该地址 → 网关完成首次配对并写入长期 cookie → 之后所有请求与 WebSocket 都经 Worker 回到网关，再转发给本机原生 WebUI（请求头改写为 loopback）。PC 端提供"建立中转"的部署步骤（文档 + 一条命令/脚本）、二维码、轮换密钥、撤销设备。一个中转对应一台电脑（插件实例），但可配对多台浏览器设备；协议预留安装 ID 字段，为将来多电脑留口。
- **Appetite**: medium（周级）
- **Trade-offs**：
  - 赢得：固定地址、浏览器零安装、PC 零额外客户端、无域名、作者零基础设施、与本地体验一致（不改 DSH 行为）。
  - 牺牲：v1 只覆盖 Worker（VPS/NAS 用户暂不可用）；无认证，安全性完全依赖链接保密与"轮换 + 撤销"；实现面比"托管 cloudflared"大（要自己做 HTTP + WebSocket 双通道与 Worker 侧复用）。
  - 风险：Worker Free 计划的 DO 额度与 WS 帧上限可能成为硬瓶颈；DSH 内部契约变化会让插件失效。
- **Rabbit holes**（最可能撑爆范围的地方）：
  - WebSocket 多路复用与大消息（会话历史、附件）的分片/旁路；
  - 断线重连与"中转重启/换网络"后的状态恢复；
  - 代理下的静态资源与 HTML 注入（SPA 路径、`/assets`、index 注入行）；
  - cookie 与信任栅栏（`Host`/`Origin` 改写、上游 `Set-Cookie` 剥离）的正确性；
  - DSH 版本升级后的兼容维护。

### Option B — 局域网直连 + 手动隧道（最小可验证切面）

- **方案轮廓**：插件只做"内网监听 + 扫码配对 + 原生 WebUI 转发"，不做中转；外网访问由使用者自己跑临时隧道（`cf tunnels quick-start` 或 cloudflared quick tunnel），地址会变、每次要重新获取。价值是先用最小成本验证"网关 + 配对 + 原生 WebUI 代理"这条主链路是否成立。
- **Appetite**: small（天级）
- **Trade-offs**：
  - 赢得：投入最小、最快看到效果；能验证最核心的技术风险（cookie 换发、WebSocket 代理、HTML 注入）。
  - 牺牲：不满足"固定地址 + 扫一次永久"（这是问题的核心目标之一）；外网访问仍要手动操作。
- **Rabbit holes**：几乎没有；但正因为简单，容易误判"方案已经可行"。

### Option C — 不做 / 用现成方案

- **方案轮廓**：不开发插件。用远程桌面（TeamViewer/向日葵）看屏幕；或用 Tailscale Funnel（需 PC 与远端都装 Tailscale）；或用 `dsh web` + 临时隧道。代价是：远程桌面重且手机体验差；Tailscale 违反"零安装"约束；`dsh web` 无法驱动桌面进程持有的会话（单写者租约），只能看新开的 Host。
- **Appetite**: small（零开发）
- **Trade-offs**：
  - 赢得：零投入、零维护。
  - 牺牲：核心痛点（远程驱动桌面会话）依然无解；"零安装 + 固定地址"的组合仍不可得。
- **Rabbit holes**：无（但会长期消耗在临时方案的操作成本上）。

## 建议

**推荐 Option A**。理由：只有它同时满足 define 里的三条硬目标（固定地址、扫一次长期可用、浏览器与 PC 双端零安装），并且把成本放在使用者自己的 Worker 上，符合作者零基础设施的约束。Option B 的价值在于它是 A 的前半段，可以作为 A 的第一个里程碑（先证明网关链路，再接 Worker），而不是独立终态。Option C 不成立，因为远程桌面与 Tailscale 都不满足约束，而 `dsh web` 受单写者租约限制。

与成功指标的关系：Option A 是唯一能达成"首次可用 ≤ 10 分钟、日常零操作、单次离开可访问率 ≥ 95%"的选项；Option B 在"日常零操作"上直接不达标。

## 不在推荐选项范围内

- VPS / NAS 中转（后续版本，协议预留安装 ID 字段）。
- 密码、失败锁定、TOTP（v1 不做，安全模型为能力链接）。
- 只读观察模式或任何 DSH 原生的额外模式。
- 改 DSH 权限模型、改造其认证与信任栅栏。
- 移动端专用 UI、多用户/权限分级、团队共享。
- 会话历史浏览、任务编排等原生已有能力。
- "建立中转"的内置向导（v1 走文档 + 一条命令）；中转自动升级。

## 需要验证的假设

- Worker Free 计划的 Durable Objects 额度与 WebSocket 帧上限足以承载真实 WebUI 流量；大流量可用普通 HTTP 旁路。
- 原生 WebUI 在代理路径下能正常工作（SPA 静态资源、index 注入、相对路径）。
- 网关可以在 loopback 上换到 host cookie，并在远端长期复用（cookie 绑定 workers.dev 域名，不受"第三方 cookie"限制）。
- 桌面 App 托盘常驻期间 Host 稳定运行，且版本升级不频繁破坏内部契约。
- 使用者愿意为"固定地址"承担一次性的 Worker 部署（文档 + 一条命令）。
