# DSHAnywhere 实现背景笔记

本文件记录评估阶段产生的、与后续实现直接相关但不属于 Spec Kit 审批产物的信息：DSH 桌面版内部机制取证结论、取证方法、接入流程草案与待验证清单。评估产物本身在 `.specify/assessments/dsh-anywhere/`。

## 一、DSH 桌面版内部机制（取证结论）

- **构成**：桌面版是 Electron 外壳（`@deepseek-ai/dsh-desktop`）加载打包好的 dsh runtime；安装目录 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，主程序 `DeepSeek Harness.exe`，runtime 在 `resources/app.asar`（本机会话取证时版本 0.2.1-rc.5）。
- **桌面 Host 启动参数固定**：`runProfile({ profile: "desktop", args: ["--no-open","--host","127.0.0.1","--port","0"] })`，即只监听回环、端口随机；窗口通过自定义 scheme 加载同一套 Web 前端，其余路径转发给 Host。
- **认证链路**：每进程生成启动令牌；`GET /?token=…`（仅根路径）→ 303 + 签名 cookie（`dsh-auth-<hash>`，绑定 hostname+port，HttpOnly，SameSite=Strict，仅监听 TLS 时带 Secure，有效期 30 天）；`/connect?token=…&interactions=answer|none` 是 API 专用、不设浏览器 cookie。
- **信任栅栏**：`Host` 必须是 loopback / 监听 IP / `trustedHosts`；`Origin` 必须同源；`sec-fetch-site: cross-site` 直接拒绝；`--host 0.0.0.0` 不支持。未认证返回 401，栅栏失败返回 403。
- **会话持久化**：追加写 `session.v4.jsonl.zstd`；同一会话由内核级单写者租约保护（POSIX `flock` 的 `session.lock`；Windows 命名信号量 `Local\dsh-session-lock-<sha256(path)>`）。争用会抛 `SessionAlreadyOwnedError`，上层映射为 `RemoteError("session/writer-held")`。**结论：另起 Host 进程无法驱动桌面进程已持有的会话。**
- **窗口语义**：关闭主窗口只是隐藏到托盘，Host 与监听端口继续存活。
- **无内置隧道**：对 `app.asar` 全量扫描 `tailscale` / `cloudflared` / `ngrok` / `wireguard` 均无命中。
- **插件可用的宿主能力**（`@deepseek-ai/dsh-host-webserver`）：`register({ kind: "exact" | "prefix", path, handler })`、`registerUpgrade({ path, handler })`（同一路径只能有一个升级处理者）、`registerFallback(handler)`（全局唯一 fallback）、`collectIndexInjections()`、`renderIndex(html)`、`protocol`、`port`、`getOrigin()`。
- **认证复用**（`@deepseek-ai/dsh-client-connection`）：`authenticatedUrl(baseUrl)` 返回带令牌的 URL；`authorizeIndex(req, res, secure)` 处理根路径认证；`createPeer({ principal, interactions })` 创建对端。
- **插件安装**：`dsh plugin --profile <name> add <pkg>` 转发给 pnpm；用户层补丁 `~/.dsh/profiles/<name>/cordis.patch.yml` 可 insert 插件条目。

## 二、取证方法（可复现）

`app.asar` 是 Electron asar 归档：开头 8 字节 size pickle，随后 4 字节 header 字符串长度，再是 JSON 头；文件数据基址 = `8 + <header 长度>`（本机该版本为 `8 + 4760404`）。

按下述脚本按相对路径取出任意文件（读取 JSON 头定位 `offset`/`size`，再从归档尾部按字节区间切出）：

```powershell
param([string]$Rel,[string]$Out)
$asar="C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"
$json=Get-Content -Raw "$env:TEMP\dsh-asar-header.json"
$i=$json.IndexOf('{'); $obj=$json.Substring($i) | ConvertFrom-Json
$base=[int64]8 + [int64]4760404
$node=$obj.files; $parts=$Rel -split '/'
foreach($pt in $parts){ $node=$node.$pt; if($node.files){ $node=$node.files } }
$off=$base + [int64]$node.offset; $len=[int]$node.size
$fs=[System.IO.File]::OpenRead($asar); $fs.Position=$off
$buf=New-Object byte[] $len; $read=0
while($read -lt $len){ $n=$fs.Read($buf,$read,$len-$read); if($n -le 0){break}; $read+=$n }
$fs.Close(); [System.IO.File]::WriteAllBytes($Out,$buf)
```

常用相对路径形如 `dsh/node_modules/@deepseek-ai/<package>/lib/index.js`。提取 JSON 头：读取 8 字节后 4 字节长度再读该长度的字节即可。

## 三、接入流程草案（v1：Cloudflare Worker 中转）

角色切片：**中转**（使用者自建，负责让公网找到电脑）→ **隧道**（插件主动出站的长连接，不开入站端口）→ **认证**（插件自己做，中转不碰凭证）。

1. 选择中转类型：Worker（v1 唯一）。
2. 建立中转：按文档 + 一条命令/脚本部署 Worker，得到 `https://<名称>.<账号>.workers.dev`。
3. 插件接入：生成安装 ID 与出口配置，建立 WSS 长连接。
4. 拿到固定地址：展示地址 + 二维码（一次性）。
5. 手机首次配对：打开能力链接 → 校验 → 写入长期 cookie（HttpOnly/Secure/SameSite=Strict）→ 跳转到不带密钥的干净地址。
6. 之后永久使用：打开同一地址即可，无需重新扫码；PC 端可轮换密钥、撤销设备。

安全模型（v1 无密码/TOTP/失败锁定）：能力链接即凭证，256 位随机；密钥不入日志、不出现在错误信息；`Referrer-Policy: no-referrer`；轮换与撤销 1 分钟内生效。

协议约定：一台电脑对应一个安装 ID，可配对多台浏览器设备；协议预留安装 ID 字段以便将来支持多台电脑。

## 四、待验证清单

- Cloudflare Worker Free 计划的 Durable Objects 请求/CPU 额度与 WebSocket 单条消息大小上限，能否承载真实 WebUI 流量；大消息改用普通 HTTP 旁路是否可行。
- 原生 WebUI 在代理路径下能否正常工作：SPA 静态资源、`/assets` 路径、index 注入行、相对路径。
- cookie 在 `*.workers.dev` 域下的长期有效性（同站首方 cookie，不受第三方 cookie 限制）。
- 插件与 DSH 桌面版本的兼容策略：锁版本 / 启动探测失败即禁用 / 提示升级。

## 五、外部事实与来源

- Cloudflare 官方 CLI `cf` 自带 `cf tunnels quick-start <url>`，其包内从 `github.com/cloudflare/cloudflared/releases/download/...` 下载 cloudflared 并以 `--no-autoupdate` 启动——"Node 程序托管隧道二进制"有官方先例。
- Cloudflare 官方 CLI 提供 `cf deploy`，可部署 Worker，可用于"建立中转"的一键部署路径。
- Durable Objects 在 Workers Free 计划有硬额度，超出后对应操作直接报错（Cloudflare 官方文档）。
- ngrok 免费账号包含一个固定 dev 域名（官方博客，2026）；Cloudflare named tunnel 需要使用者自己的域名与账号。
- 参考文档：`https://developers.cloudflare.com/durable-objects/platform/pricing/`、`https://developers.cloudflare.com/durable-objects/platform/limits/`、`https://ngrok.com/blog/free-static-domains-ngrok-users`。
