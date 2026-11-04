# Idea Research: DSHAnywhere — 浏览器远程接入桌面版 DeepSeek Harness

- **Slug**: dsh-anywhere
- **创建时间**: 2026-11-04
- **证据置信度（总体）**: medium

## 用户与需求

- **主用户是作者本人（单用户场景）**：触发点是"离开电脑时任务仍在跑，但看不到也驱动不了"。需求在四轮澄清后稳定为：浏览器端零安装、PC 端零额外客户端、地址固定、扫一次码后长期可用。 — [source: 本会话对话记录, 2026-11-04] (confidence: high)
- **默认预设已明确**：使用者必然自带 Cloudflare Worker / VPS / NAS 三者之一，并自行建立中转；作者不提供任何中转、账号或服务器。 — [source: 本会话对话记录, 2026-11-04] (confidence: high)
- **v1 认证决策**：不做密码、不做失败锁定、不做 TOTP；即安全模型退化为"链接即凭证"。 — [source: 本会话对话记录, 2026-11-04] (confidence: high)
- **同类需求人群的规模与强度**：使用本地 AI 编码/代理工具（Codex、Cursor、Claude Code 等）的人普遍有"离开电脑看长任务"的诉求，但本会话没有直接调研数据支撑。 — [source: 无 | ASSUMPTION] (confidence: low)
- **当前替代行为的成本**：现有做法是远程桌面（重、慢、手机体验差）、Tailscale（双端安装，已被明确排除）或公网映射（需要公网 IP）。用户愿意为自己的使用建 Worker 中转，说明需求强度高于"尝鲜"。 — [source: 本会话方案对比 | ASSUMPTION] (confidence: medium)

## 先例与已有实践

- **DSH 自带 `dsh web` 不能替代**：另起一个 Host 进程访问同一会话会被单写者租约拒绝（`SessionAlreadyOwnedError` → `RemoteError("session/writer-held")`），因此"把端口暴露出去"满足不了"远程驱动桌面正在跑的会话"。 — [source: 本地安装 `dsh-session-persistence-jsonl/lib/index.js`（`session.lock` / Windows 命名信号量 `Local\dsh-session-lock-<sha256>`）] (confidence: high)
- **DSH 安装包内没有内置隧道/远程访问**：对 `app.asar` 全量字节扫描 `tailscale` / `cloudflared` / `ngrok` / `wireguard` 均无命中。 — [source: 本地安装 `resources/app.asar`（182,766,714 B）全量扫描, 2026-11-04] (confidence: high)
- **"Node 程序托管 cloudflared 二进制"有官方先例**：Cloudflare 官方 CLI `cf` 自带 `cf tunnels quick-start <url>`，其包内 `cloudflared-*.mjs` 从 `github.com/cloudflare/cloudflared/releases/download/...` 下载二进制并以 `--no-autoupdate` 启动。说明本机即可复现"零手工安装"的隧道托管。 — [source: 本地 `%APPDATA%\npm\node_modules\cf`（v1.0.0-beta.27）与 `cf tunnels quick-start --help`] (confidence: high)
- **行业先例**：cloudflared（quick/named tunnel）、ngrok（免费账号含固定 dev 域名）、frp、Tailscale Funnel、localtunnel 等；共同点是"本地服务 + 出站隧道 + 公网入口"，差别在账号、域名、客户端与限额。 — [source: web_search 摘要（ngrok 官方博客、Cloudflare Tunnel 文档条目）] (confidence: medium)
- **同类形态先例**：code-server、Jupyter remote、ttyd + 隧道证明"本地 UI + 远程接入"是成熟模式，但都不是"驱动一个存活的桌面会话"。 — [source: 无 | ASSUMPTION] (confidence: low)

## 市场与现状

- **做与不做的成本**：不做则长任务期间必须守在电脑旁，或事后才能看到结果；做则把"在电脑旁"这个约束去掉。 — [source: 本会话动机 | ASSUMPTION] (confidence: medium)
- **已有替代方案的门槛**：远程桌面类方案对手机体验差、带宽高；Tailscale 类需要两端安装（用户明确排除）；公网映射需要公网 IP 与路由器配置。 — [source: 本会话方案对比] (confidence: medium)
- **差异化前提**：目标用户自带 Worker/VPS/NAS，因此"地址固定 + 无域名 + 无客户端 + 作者零基础设施"可以同时成立，这是本方案相对既有工具的站位。 — [source: 本会话约束澄清] (confidence: medium)

## 数据与约束

- **插件可用的宿主能力**：`dsh-host-webserver` 暴露 `register({kind:"exact"|"prefix"})`、`registerUpgrade({path,handler})`、`registerFallback(handler)`、`collectIndexInjections()`、`renderIndex()`、`protocol`、`getOrigin()`；插件可在同一 listener 上挂 HTTP 路由与 WebSocket 升级处理，具备做网关的技术前提。 — [source: 本地 asar 提取 `dsh-host-webserver/lib/index.js`] (confidence: high)
- **认证链路可复用**：`dsh-client-connection` 的 `authenticatedUrl(baseUrl)` 与 `GET /?token=…` → 303 + 签名 cookie（绑定 hostname+port，HttpOnly，SameSite=Strict）可被插件在 loopback 上换成 host cookie，再转发给远端。 — [source: 本地 asar 提取 `dsh-client-connection/lib/index.js`（`authenticatedUrl`、`authorizeIndex`、`createPeer`）] (confidence: high)
- **信任栅栏必须绕过式处理**：`Host` 必须为 loopback / 监听 IP / `trustedHosts`，`Origin` 必须同源，`--host 0.0.0.0` 不支持；网关转发时必须把 `Host`/`Origin` 重写为 `127.0.0.1:<port>`，并剥掉上游 `Set-Cookie`。 — [source: 本地安装实测 + `dsh-host-webserver` 源码] (confidence: high)
- **桌面常驻语义**：关闭主窗口只是 `preventDefault()` + 隐藏到托盘，Host 与监听端口继续存活，因此"App 在托盘"是远程可用的前提。 — [source: 本地 `app.asar/lib/main.js` 提取] (confidence: high)
- **插件安装方式**：`dsh plugin --profile <name> add <pkg>` 是转发给 pnpm 的薄封装（`add/remove/why`），插件可通过 profile 用户补丁层 insert 挂载。 — [source: `dsh plugin --help` 实测] (confidence: high)
- **Cloudflare Worker 平台限制**：Free 计划的 Durable Objects 有每日硬额度，超出后对应操作直接报错；WebSocket 单条消息存在大小上限，大消息需分片。 — [source: Cloudflare 官方文档（经 `cf docs search` 读取摘要，未取全文）: developers.cloudflare.com/durable-objects/platform/pricing/、/limits/] (confidence: medium)
- **Worker 部署可行性**：官方 CLI 提供 `cf deploy`（可部署 Worker/静态站点/全栈应用），因此"插件内一键部署中转"可优先复用 CLI，缺 CLI 的用户需 API Token 或另行安装。 — [source: `cf deploy --help` 实测] (confidence: high)
- **无域名 TLS 路径**：`sslip.io` / `nip.io` 用 IP 编码域名，可配合 Let's Encrypt 签发证书；VPS 需 80/443 公网可达，NAS 需先具备公网入口。 — [source: web_search 摘要（sslip.io 项目与 issue）| 未实测] (confidence: low)
- **版本耦合**：插件依赖的是 DSH 内部契约（宿主服务、会话租约、HTML 注入），不是公开 API；桌面端升级可能破坏插件。 — [source: 本地安装结构 | ASSUMPTION] (confidence: medium)

## 反对该想法的证据

- **实现工作量被低估的风险**：需要自己实现 HTTP + WebSocket 双通道转发、多路复用、大消息分片/流式、断线重连、版本握手、"安装 ID"路由；比"托管 cloudflared 二进制"体量大一个档位，单人长期维护成本高。 — [source: 架构推演 | ASSUMPTION] (confidence: medium)
- **Worker 免费额度可能撑不住实时流量**：DO 请求/CPU 日额度、WS 帧上限、CPU 时间限制都可能成为远程体验的硬瓶颈；触顶是硬失败而非降级。 — [source: Cloudflare 官方文档摘要] (confidence: medium)
- **v1 无认证的安全后果**：链接即凭证，泄露等于完全控制权（会话可执行任意工具）；浏览器历史、剪贴板、聊天链接预览、肩窥都可能导致泄露；也无法防御重放（只能靠 token 轮换）。 — [source: 本会话决策 + 安全推演 | ASSUMPTION] (confidence: high)
- **上游可能内建同类能力**：官方若提供远程访问，插件价值被吸收，投入可能沉没。 — [source: 无 | ASSUMPTION] (confidence: low)
- **NAS 路径大概率落空**：多数家用 NAS 没有公网入口，"NAS 做中转"需要额外的端口映射或厂商远程访问能力，实际可用性存疑。 — [source: 本会话讨论 | ASSUMPTION] (confidence: medium)
- **已有免费方案的存在**：cloudflared quick tunnel 或 Tailscale Funnel 已能覆盖"临时看任务"需求；本插件的增量价值集中在"固定地址 + 扫一次 + 无客户端 + 作者零参与"，若这些价值不被高频使用，投入产出比不成立。 — [source: 本会话方案对比 | ASSUMPTION] (confidence: medium)

## 缺口与待澄清

- [NEEDS CLARIFICATION: v1 无认证时，"链接泄露后的轮换与撤销"是否属于同一版本必须交付的能力？]
- [NEEDS CLARIFICATION: Worker 免费额度能否支撑真实 WebUI 流量（DO 请求/CPU、WS 帧大小、附件与长会话历史），需 POC 实测。]
- [NEEDS CLARIFICATION: NAS 可达性自检的判定口径（公网 IP、端口映射、厂商远程访问）与失败后的降级路径。]
- [NEEDS CLARIFICATION: 插件对 DSH 桌面版本的兼容策略（锁版本、探测失败即禁用、还是提示升级）。]
- [NEEDS CLARIFICATION: "生成中转部署物"是内置向导（含 API Token 流程）还是外置文档 + 一条命令。]
- [NEEDS CLARIFICATION: 成功指标（首次可用时间、日常免操作率、断线恢复时间）尚未定义，留给 define 阶段。]

## 附：取证明细与可复现步骤

**桌面版机制要点**（均为本地取证，2026-11-04）：

- 桌面 Host 以 `--no-open --host 127.0.0.1 --port 0` 启动：只监听回环、端口随机；窗口经自定义 scheme 加载同一前端，其余路径转发给 Host。
- 认证：进程启动令牌经 `GET /?token=…`（仅根路径）换 303 + 签名 cookie `dsh-auth-<hash>`（绑定 hostname+port，HttpOnly，SameSite=Strict，仅 TLS 时 Secure，30 天）；`/connect?token=…&interactions=answer|none` 为 API 专用、不设浏览器 cookie。
- 信任栅栏：`Host` 必须为 loopback / 监听 IP / `trustedHosts`；`Origin` 必须同源；`sec-fetch-site: cross-site` 拒绝；未认证 401，栅栏失败 403。
- 插件可用的宿主能力：`register({kind:"exact"|"prefix",path,handler})`、`registerUpgrade({path,handler})`（同一路径唯一）、`registerFallback`（全局唯一）、`collectIndexInjections()`、`renderIndex(html)`、`protocol` / `port` / `getOrigin()`。
- 认证复用：`authenticatedUrl(baseUrl)`、`authorizeIndex(req,res,secure)`、`createPeer({principal,interactions})`。
- 插件安装：`dsh plugin --profile <name> add <pkg>`（转发 pnpm）；用户补丁层 `~/.dsh/profiles/<name>/cordis.patch.yml` 可 insert 条目。

**asar 归档取文件方法**：开头 8 字节 size pickle、随后 4 字节 header 字符串长度、再是 JSON 头；文件数据基址 = `8 + <header 长度>`（本机该版本 header 长度为 4,760,404）。按相对路径从 JSON 头取 `offset`/`size`，再从归档中按区间切出即可，例如：

```powershell
param($Rel,$Out)
$asar="C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"
$t=Get-Content -Raw "$env:TEMP\dsh-asar-header.json"; $obj=$t.Substring($t.IndexOf('{')) | ConvertFrom-Json
$node=$obj.files; foreach($p in ($Rel -split '/')){ $node=$node.$p; if($node.files){ $node=$node.files } }
$fs=[IO.File]::OpenRead($asar); $fs.Position=[int64]8+[int64]4760404+[int64]$node.offset
$buf=New-Object byte[] ([int]$node.size); $read=0
while($read -lt $buf.Length){ $n=$fs.Read($buf,$read,$buf.Length-$read); if($n -le 0){break}; $read+=$n }
$fs.Close(); [IO.File]::WriteAllBytes($Out,$buf)
```

## 来源

- 本地安装取证：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`（本地文件，policy: 本地读取，未联网）
- 本地包提取（asar → `%TEMP%`）：`dsh-host-webserver/lib/index.js`、`dsh-client-connection/lib/index.js`、`dsh-session-persistence-jsonl/lib/index.js`、`lib/main.js`（本地文件）
- 官方 CLI 实测：`cf tunnels quick-start --help`、`cf deploy --help`、`dsh plugin --help`（本地命令）
- https://developers.cloudflare.com/durable-objects/platform/pricing/ （host: developers.cloudflare.com，policy: 仅经 `cf docs search` 取摘要，未 fetch 全文）
- https://developers.cloudflare.com/durable-objects/platform/limits/ （host: developers.cloudflare.com，policy: 同上）
- https://ngrok.com/blog/free-static-domains-ngrok-users （host: ngrok.com，policy: 仅 web_search 摘要，未 fetch）
