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

## POC-1：请求密度与响应体量（T007）

**结论：未开始。** 需要真实长任务会话 + 流量采样，尚未执行。

## POC-2：代理下的资源路径（T008）

**结论：未开始。** 需要临时 Host + `wrangler dev` + 无头浏览器，尚未执行。

## 已完成的工程基线

| 日期 | 内容 |
| --- | --- |
| 2026-11-04 | workspace 骨架（T001–T006）、帧协议编解码（T010/T011）：`pnpm typecheck` 与 `pnpm test` 全绿，12 个用例通过 |
| 2026-11-04 | 插件以 bundle 形态发布（T042）：`dsh --dump-config` 实测挂载成功 |
