# POC 实测记录

本文件记录 `tasks.md` 中 Phase 2 三个 POC 的实测数字与验收结论，供后续发布做基线对照。

## POC-3：安装步骤与补丁层（T009）—— 已完成

**结论：安装可收敛为一条命令，无需手工编辑用户的 `cordis.patch.yml`。**

### 实测环境

- macOS，DeepSeek Harness 0.2.1-rc.5（desktop 版，未单独安装 `dsh` CLI）

### 发现 1：desktop 版内置了完整 CLI

`dsh` 不在 `PATH` 中，但 app 内带有 `@deepseek-ai/dsh` 包。调用方式：

```bash
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  <args>
```

`--version` → `0.2.1-rc.5`。Windows 与 Linux 上把前两段换成本机 `DeepSeek Harness` 可执行文件即可。

### 发现 2：`dsh plugin` 只是 pnpm 的薄封装

`dsh plugin --help` 原文：*"manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory"*。
它在 profile 未初始化时先初始化（复制模板 + 建 `cordis.patch.yml`、`package.json`、`pnpm-workspace.yaml`），然后执行 `pnpm <args>`。

装**普通依赖**时会告警：

```text
dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

### 发现 3：声明 `dsh.bundle` 即成为补丁层（一条命令的关键）

包内 `package.json`：

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

包内自带的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-anywhere
      name: "@dsh-anywhere/plugin"
      config: { enabled: true }
```

实测（隔离 `DSH_HOME=/tmp/dsh-t010`）：

1. `dsh plugin --profile t add /tmp/bundle-pkg` → profile `package.json` 的 `dsh.profile.bundles` 追加该包名；
2. `dsh --profile t --dump-config` 输出中出现该包 `cordis.patch.yml` 的 `insert` 条目；
3. 整个过程**没有**触碰 profile 自身的 `cordis.patch.yml`。

### 对规格的影响

- **FR-025（文档 + 一条命令）成立**，且比原设想更好：安装是 `dsh plugin --profile desktop add <本包>` 一条命令。
- **T042 的一键安装脚本取消**：已改为在 `packages/plugin` 声明 bundle（已完成）。
- 待验证：包入口目前是 TS（`exports: ./src/index.ts`），DSH 挂载时能否直接加载 TS 尚未验证；若不能，需加一步构建产物（TS → JS），这会加一条命令或由 `postinstall` 完成。**这是 SC-001 的下一个风险点。**

## 本机端到端链路（US1，T021–T030）

**已验证**：`tests/integration/e2e-remote.test.ts` 在单进程内跑通「中转 RelayBridge ↔ 帧协议 ↔ 网关 Gateway ↔ loopback HTTP」全链路，覆盖：

- GET 请求经中转到达 loopback 并原样返回；
- 上行请求体（含中文）完整送达；
- 200 KB 大响应体经 64 KiB 分片后完整重组；
- 浏览器侧 cookie 被替换为宿主 `dsh-auth-*` cookie；
- loopback 返回 401 时换发 cookie 重试一次并成功。

**未验证（需真机环境）**：真实 DSH WebUI 的首屏资源加载、`/api/remote.mux` 实时流、`wrangler dev`/线上 Worker 的 WebSocket 行为。这些依赖真实会话与 Cloudflare 部署，见 T073。

## 断线自愈与可访问率（US5，T058–T065）

**已验证**：`tests/integration/recovery.test.ts` 用可控时钟驱动隧道状态机，实测四类中断的反应：

| 场景 | 触发 | 实测行为 |
| --- | --- | --- |
| 网络切换 | close 1006 | 进入 `reconnecting`，首个退避窗口 **500 ms**（±20%）后重连 |
| 中转重启 | close 1001 | 同上，不影响已建立的流（流由网关重建） |
| 连续失败 | 多次 1006 | 退避严格为 **500 / 1000 / 2000 / 5000 ms** |
| 凭证无效 | close 4401 | 进入 `failed`，**不自动重试**（需人工重新配对） |
| 额度受限 | close 4402 | 进入 `failed`，**不自动重试**（次日恢复） |
| 版本不兼容 | close 4002 | 进入 `failed`，不重试 |
| DNS / 证书错误 | error 事件 | 分类为 `dns` / `tls`，进入重连并按退避重试 |

**可访问率**：24 小时滑动窗口，`success / (success + failure)`；窗口过期自动归零，避免历史累计淹没近期状态。统计只记计数与分类，不记 URL 与正文（`packages/plugin/src/stats.ts`）。

**未验证**：真实网络切换、真实中转重启、桌面端退出后的恢复时间需要真机与真实部署，属 T073 环境验证范围。

## 真实安装与冷启动（T073 / POC-4）

**已实测**：把 `packages/plugin` 以 bundle 形式装进一个克隆自 desktop 的独立 profile，再用内置 CLI 冷启动 Web 形态。

```bash
cp -a ~/.dsh/profiles/desktop ~/.dsh/profiles/dshanywhere-cold
ELECTRON_RUN_AS_NODE=1 "<app>" "<bin.js>" plugin --profile dshanywhere-cold add "$PWD/packages/plugin"
ELECTRON_RUN_AS_NODE=1 "<app>" "<bin.js>" --profile dshanywhere-cold --port 50999 --no-open
```

实测结果：

| 检查 | 结果 |
| --- | --- |
| `--dump-config` 出现 `id: dsh-anywhere` 插入项 | 通过 |
| 入口是 `.ts` 文件，DSH 能否加载 | **能**：Node 26 的 strip-types 直接执行，无需编译步骤 |
| `GET /__anywhere` | 200，渲染「还没有中转」与 `npx wrangler deploy` 命令 |
| `GET /__anywhere/api/status` | 200，返回契约化 JSON（`installation.state = unconfigured`） |
| `GET /__anywhere/ui/qr.js` | 200，零依赖二维码脚本可用 |
| `GET /p/<伪造令牌>` | 401，统一「链接无效或已过期」页面 |

**过程中发现四个真实的宿主契约约束**（都已修复并回写到实现）：

1. **`inject` 必须是服务名数组**。写成 `{ required, optional }` 会被 Cordis 当成名为 `required`/`optional` 的服务，条目永远 pending。
2. **`apply` 不能返回对象**。返回 `PluginRuntime` 被判为 `TypeError: Invalid effect`，条目无法激活；改为返回 `void`。
3. **Cordis 的 `ctx` 代理对未 inject 的属性直接抛错**。`ctx.muxPath`、`ctx.logger` 都不能直接读；实时端点路径改用契约常量 `MUX_PATH`，日志走 try/catch 兜底。
4. **前缀路由的匹配规则是 `pathname === prefix || pathname.startsWith(prefix + "/")`**。注册 `"/__anywhere/"` 时 `/__anywhere/api/status` 不会命中；必须注册不带尾斜杠的 `"/__anywhere"`。

## 版本兼容禁用（T068）

`tests/integration/version-probe.test.ts` 覆盖三种宿主形态：

- 无 `webServer`：不注册任何路由，记录「DSHAnywhere 已禁用」，连接状态保持 `idle`；
- 有 `webServer` 但缺 `registerUpgrade`：同样禁用，**不出现半可用**；
- 能力齐备：注册 `prefix:/__anywhere` 与 `prefix:/p` 两条路由。

## quickstart 场景走查（T070）

对照 [quickstart.md](../specs/001-browser-remote-access/quickstart.md) 的八个场景，如实记录当前证据等级：

| 场景 | 结果 | 依据 |
| --- | --- | --- |
| 1 安装插件 | **实测通过** | 独立 profile 内 `dsh plugin add` + `--dump-config` 出现插入项 |
| 2 部署中转 | **未实测** | 需要真实 Cloudflare 账号，`wrangler` 未在本机登录 |
| 3 填入地址 | **单测通过** | `relay-url.test.ts` 覆盖 https/路径/查询串/末尾斜杠 |
| 4 扫码配对 | **单测通过** | `pairing.test.ts` + `runtime.test.ts` 覆盖 303 + `__Host-` cookie + 一次性 |
| 5 远端看到界面 | **本机链路通过** | `e2e-remote.test.ts` 证明帧路径端到端；真实 DSH WebUI 未接入 |
| 6 日常复用 | **未实测** | 需连续 5 天真实使用（SC-002 / SC-004） |
| 7 轮换与撤销 | **集成通过** | `lifecycle.test.ts`：轮换不动设备、撤销下一请求即拒 |
| 8 断线与四类故障 | **受控测试通过** | `recovery.test.ts` 退避 500/1000/2000/5000 ms；`error-mapping.test.ts` 区分呈现位置 |

**未验证清单**：真实 Cloudflare 部署与 `workers.dev` 连通性、真实手机扫码后的 DSH WebUI 首屏、真实网络切换的恢复秒数、连续 5 天的重复配对统计。这些都需要真实环境，无法在单机离线条件下替代。

## Constitution 自检（T071）

| 原则 | 结论 | 证据 |
| --- | --- | --- |
| I 原生边界 | **符合** | 只有 `adapter.ts` 接触宿主契约，对外仅 4 个包装函数；探测失败即禁用，不降级 |
| II 作者零基础设施 | **符合** | 全仓无作者域名/账号/凭据（T074 检索为空）；中转由使用者自己部署 |
| III 双端零安装 | **符合** | 浏览器端 0 客户端；桌面端一条 `dsh plugin add`；部署命令一次性 `npx` |
| IV 可撤销的能力链接 | **符合** | 链接一次性 + 10 分钟过期 + `linkEpoch` 轮换；设备撤销实时生效，均有单测 |
| V 本地优先与最小暴露 | **符合** | 只监听 loopback；远端访问管理页 404；上游 `Set-Cookie` 与平台头被剥离；中转可见明文已在安全文档中明示 |

## POC-2：代理下资源路径是否需改写（T008）

**已实证（静态分析 + 冷启动实测）**，结论是**不需要改写**：

1. `dsh-web-frontend/dist/index.html` 里的资源引用全部是**相对路径**：
   `./assets/index-BXV-oxvX.js`、`./manifest.webmanifest`、`./favicon.svg`。
2. 前端 bundle 中 `pushState`/`replaceState`/`location.hash`/`pathname` 出现次数**均为 0**——
   这个 SPA 没有 URL 路由，也就没有深链。
3. 我们的代理把请求原样转发到 loopback，入口固定在根路径 `/`，因此相对路径在中转下与在本机下
   解析结果完全一致。
4. 冷启动实测：`GET /__anywhere`、`/__anywhere/api/status`、`/__anywhere/ui/qr.js` 均正常返回，
   静态资源不受前缀影响。

**风险点在别处**：如果将来 DSH 引入 URL 路由或把入口挂到子路径，相对资源路径会失效；届时
需要在 `adapter.ts` 增加 `rewriteLoopbackUrls` 开关（已在风险表中登记），而不是现在提前实现。

## POC-5：真实 Cloudflare 中转部署与端到端联调（2026-11-04 实测）

**已实测通过**：中转按文档步骤部署到 `https://dsh-anywhere-relay.<账号子域>.workers.dev`（使用者自己的账号；本机 `cf` 已登录而 `wrangler` 未登录，部署时把 `cf` 的 OAuth token 通过 `CLOUDFLARE_API_TOKEN` 传给 wrangler，未把任何凭据写入仓库）。

实测结论与数字：

| 项目 | 结果 |
| --- | --- |
| `GET /__relay/health` | `200 {"ok":true,"protocolVersion":1}` |
| 无电脑端在线时访问入口 | `503` + 「电脑端未运行」页（远端可见、无堆栈） |
| 非白名单 WS 升级路径 | `404`（与契约一致） |
| 真实页面加载（浏览器 1280×633） | 侧边栏、会话列表、工作区、输入框全部渲染，可点击切换会话 |
| 首屏 HTML | 41 042 B，1.5–2.3 s（经本机代理出口） |
| 页面总请求 | 12 个（1 HTML + 2 组合包 + 3 静态资源 + 若干 `/api/*`） |
| 单响应体量峰值 | **8 937 KB**（`/plugins/??...` 组合包），其次 2 444 KB、919 KB、724 KB |
| 一次完整页面加载总下行 | **约 13.3 MB** |
| 941 KB 主包耗时 | 4.2 s（23:5x）→ 20.8 s（跨零点复核），说明吞吐随出口网络波动很大 |
| 实时通道 `/api/remote.mux` | 经 Worker→DO→隧道→loopback 打通，空闲保持 45 s 不掉线 |

### 真实部署暴露的 6 个"只有上线才会出现"的问题（均已修复并加了测试）

1. **`Upgrade` 头被 Cloudflare 剥掉**：Worker 里 `request.headers.get("upgrade")` 恒为 `null`，
   只剩 `connection: Upgrade` 和 `sec-websocket-*`。原来的升级判断永远为假 → 代理永远拿不到 WS。
   改为多信号判断（`sec-websocket-key` / `connection` / 显式标记）。
2. **升级请求不能重新包装**：`new Request(url, {...})` 转发给 DO 会丢失升级语义，客户端收到 1006。
   改成升级请求原样 `stub.fetch(request)`。
3. **`acceptWebSocket()` 与 `addEventListener` 不能混用**：一旦走 hibernation API，
   `message` 事件永远不触发，表现为"握手静默失败"。改用 `server.accept()`。
4. **浏览器把二进制帧当 Blob 交付**：Node/undici 的 `WebSocket` 默认 `binaryType = "blob"`，
   直接 `new Uint8Array(blob)` 会解析失败并被当成坏帧断开。显式设 `binaryType = "arraybuffer"` 并兼容 Blob。
5. **`send()` 在断连瞬间抛 `InvalidStateError: Sent before connected`**：异常发生在事件回调里会带崩宿主进程。
   改为返回布尔值，网关侧捕获后丢弃该帧。
6. **非法 WS 关闭码会抛 `InvalidAccessError`**：DSH/上游可能给出 0 或 1006，
   `ws.close(0)` 直接抛异常。统一用 `closeSafely` 归一化到合法码。

### 协议层实测修正

- **DSH 实时通道只接受文本帧**：把文本当二进制转发会被 `1003 text messages required` 拒绝。
  `WS_DATA` 的 `WS_TEXT` 标记必须在双向都保留（已加测试）。
- **单条 WS 消息会超过 64 KB**：会话历史快照一次可达数百 KB，超过单帧上限会被直接丢弃且没有提示
  （现场表现为「载入历史…」一直转圈）。现在 `WS_DATA` 用 `WS_MORE` 标记做分片传输，两端都累积后
  再交给 WebSocket；Cloudflare 的 1 MiB 单消息上限因此只约束"对端一次交付"，不再约束协议帧。
- **WebSocket 握手头必须剥离**：把浏览器的 `sec-websocket-key/version/extensions` 透传给 loopback 会造成重复键、
  握手失败，`rewriteRequestHeaders` 已把这些头加入丢弃列表。

### 部署运维发现

- **Durable Object 会继续跑旧代码**：重新 `deploy` 后，已存在的 DO 实例仍执行创建时的脚本版本，
  表现为"改了代码但行为没变"，而且旧实例里的内存状态（如已连接的 agent）也会一直留着。
  升级中转后如果发现行为没变，用 `npx wrangler delete --name <worker> && npx wrangler deploy`
  重建，会得到全新的实例（设备配对在桌面端与浏览器侧，不在 DO 里，删了不丢配对）。
- `cf deploy` 需要新的 `cloudflare.config.ts`（实验性新配置）；经典 `wrangler.toml` 项目仍建议用
  `npx wrangler deploy`，文档里的配置路径已修正为 `packages/relay/wrangler.toml`。

### 真实配对链路（2026-11-04 实测，走真实 Cloudflare 中转）

用真实插件（`dsh plugin add` 安装进独立 profile）+ 真实中转验证，全部通过：

| 场景 | 结果 |
| --- | --- |
| 未配对访问入口 | `401` + 统一「需要配对」页 |
| `POST /__anywhere/api/link` | 返回 `pairUrl`（中转域名 + `/p/<32 字符>`） |
| 打开能力链接 | `303` + `Set-Cookie: __Host-dshanywhere=…`（`Path=/`、`Secure`、`HttpOnly`、`SameSite=Lax`） |
| 带 cookie 再访问入口 | `200`，返回 DSH 首页 41 042 B |
| 再次打开入口（免操作） | `200`（FR-006） |
| 配满 10 台后再配对 | `403` + 「设备已达上限」页，active 设备数保持 10（FR-007） |
| 撤销全部设备后访问 | `401`（FR-017） |
| 撤销后重新配对 | `303` + `200` |

**过程中修复的两个真实缺陷**：

1. **配对路径被设备鉴权拦掉**：`/p/<token>` 也走网关的 `authorize`，未配对浏览器永远拿不到 cookie（401）。
   现在 `/p/<一次性令牌>` 在鉴权前放行。
2. **插件自己签发的设备 cookie 被当成上游 cookie 剥掉**：`filterResponseHeaders` 会丢弃所有 `Set-Cookie`
   以防 loopback 会话 cookie 外泄，结果 `__Host-dshanywhere` 也被丢。现在只放行这一个名字。

### 分发形态：必须发布编译产物

`dsh plugin add` 把包装进 profile 的 `node_modules`，而 Node 的 strip-types **不允许**处理
`node_modules` 下的 `.ts`，直接以 `src/index.ts` 作为入口会启动失败：

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

因此插件改为 esbuild 打包成单文件 `dist/index.js`（`pnpm run build`），`exports` 指向它，
`files` 带上 `dist`、`ui`、`cordis.patch.yml`。改动后同一命令安装启动成功。
`cordis.patch.yml` 曾因未列入 `files` 而丢失，导致 profile 拒绝加载（"failed to read overlay"），已修正。

### 第二轮真实联调（2026-11-05 上午，真实中转 + 真实插件）

| 场景 | 实测结果 |
| --- | --- |
| 管理页二维码 | 修复前 canvas 全透明（脚本语法错误），修复后 212×212、44 944 个不透明像素，可直接扫 |
| 浏览器扫码等价链路（打开 `/p/<token>`） | 303 → 自动回首页 → UI 完整渲染 |
| 打开 212 步的长会话 | 历史正常加载，无「载入历史…」卡死，控制台无报错（分片生效） |
| 杀掉电脑端后再访问 | 503「电脑端未运行」页 |
| 重启电脑端 | 隧道 **2 s** 恢复；已打开的远端页面侧栏从「重新连接中…」自动恢复，无需刷新 |

再次发现并修复两个只在真实环境暴露的问题：

1. **二维码从未渲染**：`ui/qr.js` 用 `export` 写成了 ES 模块，而页面用普通 `<script>` 引入，
   浏览器直接语法错误、`window.DSHAnywhereQr` 不存在。改为 `type="module"` 才真正画出二维码。
2. **重连被自己的旧连接挡住**：DO 收到同一安装的新连接时直接回 `409 电脑端已连接`，
   而半死的旧 socket（进程被杀、网络切换）不会立刻触发 `close`，结果这台电脑永久连不上。
   改为「后到者接管」：先关旧连接（4003）再接受新的。修复前连续 20+ 次重连全是 409，修复后立即连上。

### 仍未实测（不编造）

- 手机真实扫码配对进 DSH WebUI（需要手机与真实浏览器会话）。
- 真机（手机）上的完整交互流程与移动网络下的首屏时间。
- 在 4G/Wi-Fi 切换下的秒级恢复数据。
- 13 MB 首屏在移动网络下的首屏时间；桌面端经代理出口实测已达 10–20 s，移动网络预计更慢，
  与"速度由网络环境和 Worker 可连通性决定"的既定结论一致。

## POC-1：请求密度与响应体量（T007，2026-11-04 实测）

用真实 DSH WebUI 经真实中转加载，采集到的数据（与 spec 的 R1/R5 假设对照）：

| 指标 | 实测 | 对 R1/R5 的意义 |
| --- | --- | --- |
| 首屏请求数 | 12 | 原假设"首屏 ~15 个请求"量级正确 |
| 首屏总下行 | 约 13.3 MB | **远高于 R5 假设的 ~1 MB**：DSH 的两个 `/plugins/??...` 组合包合计 ~11.4 MB |
| 单响应最大 | 8 937 KB | 单请求可达 9 MB，是首屏慢的主因，且只能靠浏览器缓存消化 |
| 实时通道 | 1 条常驻 WS（`/api/remote.mux`），空闲 45 s 无非预期流量 | 长任务的流量都在 WS 上，HTTP 请求密度不会随任务时长增长 |
| 心跳开销 | 25 s 一次 PING，可忽略 | — |

结论：
1. 中转侧不需要为"长任务请求密度"做特殊设计——HTTP 请求数在首屏之后基本不再增长，任务进展全部走实时通道。
2. 首屏体量才是瓶颈：13 MB 在慢网下需要 10–20 s（桌面端实测），移动网络会更久。
   缓解手段是浏览器缓存（组合包的 `&rev=` 带版本号，可长期缓存），而不是压缩通道。
3. 8 937 KB 的响应验证了「大响应必须分片 + 窗口流控」这一设计是必要的，且现有实现能跑通。

## 已完成的工程基线

| 日期 | 内容 |
| --- | --- |
| 2026-11-04 | workspace 骨架（T001–T006）、帧协议编解码（T010/T011）：`pnpm typecheck` 与 `pnpm test` 全绿，12 个用例通过 |
| 2026-11-04 | 插件以 bundle 形态发布（T042）：`dsh --dump-config` 实测挂载成功 |

## 联调工具

`scripts/bench-agent.mjs` 是**开发期**用的隧道压测/联调代理（不随插件发布）：它把自己当成电脑端，
连到真实中转并按帧转发到本机 DSH，用来在没有桌面版 UI 的情况下测中转链路与流量。
用法：`BENCH_INSTALL_ID=<与中转 DSH_INSTALL_ID 一致> node scripts/bench-agent.mjs <中转地址> <本机地址> "<带 token 的 URL 的查询串>"`，
运行中 `SIGUSR2` 打印统计、`SIGINT` 退出。

## 管理界面的落点

早期实现把管理界面做成了插件自己渲染的 HTML 页（`/__anywhere`）。这与产品预期不符——
配对与设备管理应当就是 DSH 自己的界面。现在它们以 **设置 → 远程接入** 页呈现
（`packages/plugin/client.js` 注册进 `settings.section`，走同源 `/__anywhere/api/*`）；
`/__anywhere` 只作为无 JS 降级路径保留。浏览器打开中转入口时，未配对显示配对说明页，
配对后直接就是 DSH 自己的 WebUI。

## 原生设置页的设计语言（远程接入页对其）

对照 DSH 自己的设置页（通用设置 / 模型 / 内置插件）后，远程接入页按同一套语言重做：

- 页面结构：17px 标题 + 一句话灰色说明，下面才是内容块
- 内容块是白卡片（`--dsw-alias-bg-layer-1` 底、`--dsw-alias-border-l1` 细边、12px 圆角、14/16px 内边距），不再自造边框和阴影
- 主操作是一条通栏虚线按钮（对应「＋ 添加模型提供商」），生成后在同一位置展开二维码卡片
- 列表行 = 左侧名称 + 灰色次要信息，右侧胶囊描边按钮或红色文字按钮（对应「编辑 / 删除」）
- 全部颜色走主题令牌（`--dsw-alias-label-*`、`--dsw-alias-border-*`、`--dsw-alias-state-*`），浅色/深色都跟随宿主；二维码画布固定白底是为了可扫
