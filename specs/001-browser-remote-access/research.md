# Phase 0 研究：DSHAnywhere 远程接入的技术决策

**Feature**: `001-browser-remote-access` | **日期**: 2026-11-04

本文件记录 plan 阶段需要消解的技术未知项。每条给出**决策 / 理由 / 备选方案**，并标注证据等级：`实证`（本机或本机 CLI 直接验证）、`文档`（官方文档，经 `cf docs search` 取得）、`推演`（无直接证据，需 POC 验证）。

## R1 平台额度与硬上限

**决策**：以 Workers Free + SQLite 后端 Durable Objects 为 v1 唯一运行形态；按「每请求廉价、每消息分片、静态资源缓存」三条约束设计，并为额度触顶准备显式失败路径。

**证据（文档，2026-11-04 `cf docs search`）**：

| 项 | 数值 | 出处 |
| --- | --- | --- |
| Workers Free 请求 | 100,000 / 日 | `developers.cloudflare.com/workers/platform/limits/#account-plan-limits` |
| Workers Free CPU | 10 ms / 调用 | 同上 |
| Workers Free 内存 | 128 MB | 同上 |
| Workers Free 并发出站连接 | 6 / 请求 | 同上 |
| Durable Object 类数量 | Free 100 / Paid 500 | `developers.cloudflare.com/durable-objects/platform/limits/` |
| DO 存储（Free） | 5 GB / 账号 | 同上 |
| DO 单条 WebSocket 消息 | 32 MiB（仅接收方向受限） | 同上 |
| DO 免费额度 | 含 1,000,000 请求 / 月 | `developers.cloudflare.com/durable-objects/platform/pricing/` |

**理由**：32 MiB 的消息上限远高于本方案需要的单帧尺寸，分片不是被迫的妥协而是为了控制内存峰值与背压粒度（见 R5）。100,000 请求/日对「单人、偶尔远程看任务」的用量有充足余量：一次页面加载约 10~30 个请求，一天几十次访问仍在千级。

**备选方案**：
- Workers Paid：额度充足，但违反"使用者零额外成本"的默认预设，v1 不要求。
- 不用 DO、只用 Worker：见 R2，不成立。

**未消解项**：真实 WebUI 在一轮长任务中的请求密度（流式输出是否走 HTTP 轮询还是长连接）需在 POC 中实测，结论写回本文件。

## R2 为什么必须有 Durable Object

**决策**：使用单个 Durable Object 作为 agent 与浏览器连接的汇聚点。

**理由（实证）**：Workers 的 `fetch` 是无状态的，每次请求可能落在不同 isolate。**agent（桌面端）的长连接与浏览器连接必须落在同一个执行实例里才能互相转发**，否则中转无法把浏览器请求送给桌面端。DO 是平台提供的唯一"有身份、有单实例串行语义"的汇聚原语，且其 hibernatable WebSocket 允许空闲时不消耗 duration。

**备选方案**：
- **纯 Worker + 无 DO**：两条入站连接无法互通，不可行。
- **Worker 主动回连桌面端（桌面端监听公网）**：违反 Constitution V（不默认要求公网暴露），且需要端口映射与证书。
- **改用 Cloudflare Tunnel（cloudflared）**：需要用户安装二进制（违反 III），且命名隧道要域名与证书；quick tunnel 地址每次变化（违反 SC-002/SC-004 的"固定地址 + 零重复配对"）。
- **用 D1/KV 做请求队列轮询**：需要桌面端反复轮询，破坏实时性且请求数爆炸。

## R3 认证归属：放在插件侧，中转不持凭证

**决策**：能力链接校验、设备凭证签发、轮换、撤销全部在插件（桌面端）完成；Worker/DO 只做帧转发，不解析 Cookie 语义，也不知道任何密钥。

**理由**：
- Constitution II/IV 要求作者零基础设施、密钥不外泄；中转若持有校验密钥，就等于让使用者的中转成为凭证托管方，一旦中转被攻破即全盘失守。
- 概念阶段已定「认证（插件自己做，中转不碰凭证）」。
- 实现上完全可行：浏览器把 Cookie 交给中转，中转原样放进帧；插件校验后才转发真正的本地请求。

**代价**：每个请求多一次到桌面端的往返校验（实际是同一个往返，因为请求本来就要送到桌面端），无额外成本。

**备选方案**：
- **中转签发 cookie（用 Worker secret 签名）**：部署时要额外注入 secret，凭证跨两处，撤销需要双端同步，弃用。
- **中转侧用 Cloudflare Access 做前置认证**：需要配置身份提供商与策略，远超"一条命令"，且把账号体系引入到本应零账号的方案里。

## R4 与 DSH 内部契约的对接面（实证，本机 `app.asar` 0.2.1-rc.5）

从 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 提取 `dsh-host-webserver`、`dsh-client-connection`、`dsh-api-gateway` 三个包的 `lib/index.js` 后得到：

| 事实 | 证据 | 对设计的影响 |
| --- | --- | --- |
| `WebServer` 公开 `register({kind:"exact"|"prefix",path,handler})`、`registerUpgrade({path,handler})`、`registerFallback(handler)`、`tapIndex(transform)`、`collectIndexInjections()`、`renderIndex(html)`、`protocol`、`port`、`getOrigin()` | `dsh-host-webserver/lib/index.js` 第 294~539 行 | 插件可寄生在已有 listener 上，无需新开端口；管理页用 `register` |
| 升级路由**只按精确路径匹配**，未匹配即 `socket.destroy()` | 同文件 `server.on("upgrade", …)` 分支 | 网关只需处理一个已知升级路径，无需实现通配 upgrade |
| 浏览器实时流量的唯一升级端点是 `/api/remote.mux`（`dsh-api-gateway` 注册） | `dsh-api-gateway/lib/index.js` 第 133、785~820 行 | **这是关键简化**：插件只要把一个路径的 WS 代理好，就覆盖了全部实时通道 |
| `/api` 是 `prefix` 路由，先过 `connection.admit(req)` 栅栏，再进 `bridge` | `dsh-client-connection/lib/index.js` 第 1047~1060 行 | 栅栏由 DSH 自己执行，插件只需让请求"看起来"来自 loopback |
| 浏览器认证：`authenticatedUrl(baseUrl)` 把启动令牌拼成 `?token=`；`GET /?token=…` 返回 303 + 签名 cookie（`dsh-auth-<hash>`，绑定 `hostname:port`，`HttpOnly; SameSite=Strict`，仅 TLS 时 `Secure`，默认 30 天） | `dsh-client-connection/lib/index.js` 第 276~348、440~500 行 | 插件在进程内即可换发一次 host cookie，之后长期复用；cookie 过期时**可静默重新换发**，用户无感（满足 FR-006 与 SC-004） |
| Cookie 载荷含 `authority`（由 `Host` 头与监听协议推出），校验时要求 `authority` 一致 | 同文件 `authenticate()` / `requestAudience()` | 网关必须以 `127.0.0.1:<port>` 作为 `Host` 转发，否则 cookie 校验必失败 |
| 信任栅栏要求 `Host` 为 loopback/监听 IP、`Origin` 同源，`sec-fetch-site: cross-site` 拒绝 | 同文件 `admit` 分支 + `dsh-host-webserver` 注释 | 网关必须改写 `Host`/`Origin`/`Referer`，并剥离上游 `Set-Cookie` |

**决策**：适配层只依赖上表 6 个能力，并把这 6 处封装在 `packages/plugin/src/adapter.ts`，其余模块不得直接 `import` DSH 包。

**备选方案**：直接对 `127.0.0.1:<port>` 发原始 HTTP 而不注入 cookie —— 会被 401 拒绝；每次请求都重新用 `?token=` 换 cookie —— 多一次往返且产生 303，弃用。

**未消解项**：`maxAgeDays` 的配置入口（决定 cookie 实际寿命与重新换发时机）需在实现时读取宿主配置，POC 验证。

## R5 大消息、分片与背压

**决策**：单帧上行 ≤ 64 KiB，下行同样 ≤ 64 KiB；每个流有窗口（默认 256 KiB），接收方确认后才继续发。

**理由**：DO 单条消息上限 32 MiB 虽宽，但 128 MB 内存与 10 ms CPU 都是硬约束；一次把 20 MB 的历史记录塞进单帧会在 Worker 侧产生巨大内存压力并可能触发 CPU 超时。64 KiB 分片让内存占用与服务端处理时间都可预期，也让背压有自然粒度。

**备选方案**：
- 单帧直传大消息：简单，但峰值内存与 CPU 不可控。
- 大流量走 HTTP 旁路（概念阶段提及）：可作为 v1.1 优化，v1 先用分片；若 POC 证明附件/历史确实受阻，再引入。

**未消解项**：真实会话历史的最大单次响应体量，POC 实测。

## R6 中转部署形态与"一条命令"

**决策**：`relay/` 目录自带 `wrangler.toml` 与 Worker 源码（含 DO 配置与 migration）；使用者执行

```bash
npx wrangler deploy --config relay/wrangler.toml
```

首次运行由 wrangler 引导浏览器登录自己的 Cloudflare 账号，无需预装任何客户端、无需域名、无需 API Token 手工创建。

**理由**：`npx` 不需要常驻安装，符合 Constitution III 的"零安装"；`wrangler.toml` 里 `workers_dev = true` 即可拿到固定 `*.workers.dev` 地址（满足 FR-003/SC-001 的无域名要求）。

**备选方案**：
- `cf deploy`：本机有 `cf` CLI，但其面向本仓库作者的验证与运维；终端用户不应被要求先装 `cf`。文档中以注释形式给出该备选。
- 手工在 Dashboard 建 Worker 并贴代码：步骤多、易错，且 DO migration 无法用粘贴完成。

**未消解项**：`wrangler deploy` 是否会因 DO 的 SQLite 后端需要显式 migration 标记而中断（`new_sqlite_classes`），需在首次真实部署时确认。

## R7 代理下的静态资源与 index 注入（待 POC）

**决策**：v1 不做 HTML 改写，假设原生 WebUI 的资源引用与 SPA 路由在"根路径代理"下可直接工作；若 POC 证伪，退回到 `adapter.ts` 内的 `tapIndex` 注入一个 `<base>` 或路径前缀修正。

**风险点**：`renderIndex` 注入行、`/assets` 前缀、SPA 的 history 路由，以及可能的绝对 URL（`http://127.0.0.1:<port>`）泄漏到 HTML 或 JS 中。若存在绝对 URL，浏览器会把请求发到自己的 loopback —— 直接失败。

**验证方法**：POC 用真实 Host 起一个会话，经本地 `wrangler dev` 中转，用无头浏览器打开首屏，抓取所有请求 URL 检查是否同源。

## R8 断线与恢复

**决策**：插件侧指数退避重连（0.5 s → 1 s → 2 s → 5 s 封顶，带 ±20% 抖动）；心跳 25 s；DO 侧用 hibernatable WebSocket，agent 断开时把待发请求以统一错误码立即失败，不排队等待。

**理由**：SC-003 要求 30 秒内恢复。最坏路径是"中转重启"——DO 实例被重建，agent 需要重连并重新握手；5 秒封顶的退避保证在 30 秒窗口内至少尝试 4~5 次。不排队是为了避免"电脑端休眠后回来收到一堆陈旧请求"。

**备选方案**：固定间隔重连（简单但风暴风险）；长轮询兜底（复杂且无必要）。

## R9 版本兼容探测

**决策**：启动时断言 6 个适配能力存在（`webServer.register`、`registerUpgrade`、`getOrigin`、`connection.authenticatedUrl`、`api-gateway` 的 `/api/remote.mux` 路由存在性可间接探测、`admit` 行为）。任一缺失 → 不启动隧道，状态页显示"当前 DSH 版本不兼容"，并记录期望版本与实测版本。

**理由**：FR-027 要求不兼容即禁用并提示，不得静默降级。断言式探测比版本号比较更鲁棒（版本号可能被发行方改动）。

**备选方案**：只比 `package.json` 版本号 —— 对内部包不做语义化承诺，脆弱。

## R10 插件安装与 profile 补丁层

**决策（已实证，2026-11-04）**：`packages/plugin` 以 **bundle 形态**发布——`package.json` 声明 `dsh.bundle.patch` 指向自带的 `cordis.patch.yml`。这样 `dsh plugin --profile desktop add <包>` 一条命令即完成「安装 + 挂载」，使用者不需要手工编辑自己的补丁层。

**证据（实证）**：
1. desktop 版内置 CLI：`ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" <args>`，`--version` 输出 `0.2.1-rc.5`。
2. `dsh plugin --profile <name> <args>` 把参数原样转给 pnpm（`plugin --help` 原文："forwarding the remaining arguments to pnpm in the profile directory"）。
3. 装普通依赖时 CLI 明确告警：`declares no dsh.bundle — installed as a plain dependency, not a profile layer`。
4. 装声明了 `dsh.bundle.patch` 的包时，包名被追加进 profile `package.json` 的 `dsh.profile.bundles`，且 `dsh --profile <name> --dump-config` 显示出该包 `cordis.patch.yml` 中的 `insert` 条目。

**备选方案**：发布到 npm 并提供 `dsh plugin add @dsh-anywhere/plugin`——公开包名带来作者维护责任，v1 仍以本地路径/压缩包安装，但 bundle 形态使该路径可随时切换。

**已消解**：原「两条命令是否挤爆 10 分钟」的疑问不再成立——安装收敛为一条命令，`scripts/install.mjs` 一键脚本方案取消。

## R11 数据落盘

**决策**：插件状态存 `~/.dsh/storages/dsh-anywhere/state.json`，写入用「临时文件 + rename」原子替换，文件权限 0600，目录 0700。

**理由**：不引入数据库依赖；设备表规模（≤10）与访问计数都极小；JSON 便于用户排障与卸载清理。密钥字段（能力链接摘要、设备凭证摘要）只存摘要，不存明文。

**备选方案**：沿用 DSH 的 storage 服务抽象（若存在统一 API 则优先使用，需在实现时确认）；SQLite（对一个 10 行的表过重）。

## R12 安全细节

**决策**：
- 浏览器设备 cookie 用 `__Host-dshanywhere`：强制 `Secure`、`Path=/`、无 `Domain`，中转子域无法覆盖。
- 能力链接 10 分钟内有效，使用一次即作废；只存 SHA-256 摘要。
- 轮换 = 递增 `linkEpoch` 并清空未使用链接；设备凭证带 `linkEpoch` 之外的独立随机量，轮换不影响已配对设备（与 spec 的假设一致）。
- 撤销 = 立即从设备表删除并递增 `revokeEpoch`，网关对每次请求做一次内存查找（O(1)，无缓存延迟）。
- 统一失败响应：401 + 固定中文提示页，不区分「不存在/已过期/已撤销」。
- 所有经网关的响应追加 `Referrer-Policy: no-referrer` 并剥离上游 `Set-Cookie`（除了插件自己下发的那个）。

**理由**：在"能力链接即凭证"的模型下，泄露后的止损速度是唯一防线（Constitution IV）；把撤销做成无缓存的内存查找，是"1 分钟内生效"的最强保证。

**未消解项**：`no-referrer` 与 WebUI 自身资源的兼容性（若某些子资源请求依赖 Referer，将出现功能退化），POC 验证。
