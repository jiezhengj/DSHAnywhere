# POC 实测记录

本文件记录 `tasks.md` 中 Phase 2 三个 POC 的实测数字与验收结论，供后续发布做基线对照。

## POC-3：安装步骤与补丁层（T009）

**结论：部分完成——受环境阻塞。**

- `dsh` CLI 不在本机 `PATH` 中（`command -v dsh` 无输出），因此无法直接验证 `dsh plugin --profile desktop add` 是否自动写入 profile 补丁层。
- 已确认 profile 目录存在且形态符合预期：`~/.dsh/profiles/desktop/` 下有 `cordis.yml`、`cordis.patch.yml`（48 KB）、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`node_modules/`。
- 待验证问题（决定 FR-025 / SC-001 是否仍成立）：
  1. `dsh plugin add` 是否会在 `cordis.patch.yml` 追加 `insert` 条目，还是需要手工编辑；
  2. 两条命令的总耗时是否落在 10 分钟预算内。

**下一步**：在具备 `dsh` CLI 的机器上执行
```bash
dsh plugin --profile desktop add <本地包路径>
```
并观察 `cordis.patch.yml` 的 diff 与耗时，把结果补记在此。

## POC-1：请求密度与响应体量（T007）

**结论：未开始。** 需要真实长任务会话 + 流量采样工具，尚未执行。

## POC-2：代理下的资源路径（T008）

**结论：未开始。** 需要临时 Host + `wrangler dev` + 无头浏览器，尚未执行。

## 已完成的工程基线

| 日期 | 内容 |
| --- | --- |
| 2026-11-04 | workspace 骨架（T001–T006）、帧协议编解码（T010/T011）：`pnpm typecheck` 与 `pnpm test` 全绿，12 个用例通过 |
