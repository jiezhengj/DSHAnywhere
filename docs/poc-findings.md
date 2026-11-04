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

## POC-1：请求密度与响应体量（T007）

**结论：未开始。** 需要真实长任务会话 + 流量采样，尚未执行。

## POC-2：代理下的资源路径（T008）

**结论：未开始。** 需要临时 Host + `wrangler dev` + 无头浏览器，尚未执行。

## 已完成的工程基线

| 日期 | 内容 |
| --- | --- |
| 2026-11-04 | workspace 骨架（T001–T006）、帧协议编解码（T010/T011）：`pnpm typecheck` 与 `pnpm test` 全绿，12 个用例通过 |
| 2026-11-04 | 插件以 bundle 形态发布（T042）：`dsh --dump-config` 实测挂载成功 |
