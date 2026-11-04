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

## POC-1：请求密度与响应体量（T007）

**结论：未开始。** 需要真实长任务会话 + 流量采样，尚未执行。

## POC-2：代理下的资源路径（T008）

**结论：未开始。** 需要临时 Host + `wrangler dev` + 无头浏览器，尚未执行。

## 已完成的工程基线

| 日期 | 内容 |
| --- | --- |
| 2026-11-04 | workspace 骨架（T001–T006）、帧协议编解码（T010/T011）：`pnpm typecheck` 与 `pnpm test` 全绿，12 个用例通过 |
| 2026-11-04 | 插件以 bundle 形态发布（T042）：`dsh --dump-config` 实测挂载成功 |
