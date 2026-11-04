# Tasks: DSHAnywhere 浏览器远程接入

**Input**: Design documents from `/specs/001-browser-remote-access/`

**Prerequisites**: [plan.md](plan.md)、[spec.md](spec.md)、[research.md](research.md)、[data-model.md](data-model.md)、[contracts/](contracts/)

**Tests**: 本项目的 Constitution《开发工作流》要求提交前完成单元测试与本机端到端验证，因此测试任务为**必需**，且在每个故事内先写测试再写实现。

**Organization**: 按用户故事分阶段，每个阶段可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1~US5）
- 每条任务都带确切文件路径

## Path Conventions

按 [plan.md](plan.md) 的 monorepo 结构：`packages/protocol/`、`packages/plugin/`、`packages/relay/`、`tests/`、`docs/`。

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 建立可编译、可测试、可部署的空骨架

- [x] T001 初始化 workspace 根：`package.json`（`workspaces: ["packages/*"]`、`"type": "module"`）与 `tsconfig.base.json`（`strict`、`target ES2022`、`moduleResolution bundler`）
- [x] T002 [P] 建立协议包骨架：`packages/protocol/package.json`、`packages/protocol/tsconfig.json`、`packages/protocol/src/index.ts`
- [x] T003 [P] 建立插件包骨架：`packages/plugin/package.json`（`@deepseek-ai/cordis` 为 peerDependency）、`packages/plugin/tsconfig.json`
- [x] T004 [P] 建立中转包骨架：`packages/relay/package.json`、`packages/relay/wrangler.toml`（空绑定）、`packages/relay/src/index.ts`
- [x] T005 配置根脚本 `package.json`：`test`（`node --test`）、`typecheck`（`tsc -b --noEmit`）、`build`
- [x] T006 [P] 配置 `.prettierrc.json` 与 `.gitignore`（追加 `dist/`、`.wrangler/`、`node_modules/`）

---

## Phase 2: Foundational（阻塞性前置）

**Purpose**: 协议、存储、适配层、隧道与中转骨架——任何用户故事都依赖这些

**⚠️ CRITICAL**: 本阶段完成前不能开始任何用户故事

### 平台与契约验证（先做，失败则重规划）

- [ ] T007 **阻塞：需真实长任务会话** POC-1：用真实会话采样一轮长任务的请求密度与单次响应体量（对照 research.md R1/R5），把数字与结论写入 `docs/poc-findings.md`。本机无法在不产生真实模型调用与长任务的前提下复现，且现有并发/分片行为已由 `e2e-remote.test.ts`、`recovery.test.ts` 覆盖，故标注阻塞而非完成。
- [x] T008 POC-2：起临时 Host + `wrangler dev` 中转 + 无头浏览器，抓首屏全部请求 URL，确认无指向 `127.0.0.1:<port>` 的绝对地址（R7）；若存在，记录需注入的改写规则到 `docs/poc-findings.md`
- [x] T009 POC-3：验证 `dsh plugin --profile desktop add` 的挂载行为（R10）——已确认为「包声明 `dsh.bundle` 即成为补丁层」，无需手改用户补丁层；结论见 `docs/poc-findings.md`

### 协议层

- [x] T010 [P] 实现帧编解码 `packages/protocol/src/codec.ts`（12 字节头：version/type/flags/streamId/length），测试 `tests/unit/codec.test.ts` 覆盖越界长度、未知 type、空载荷
- [x] T011 [P] 定义帧类型与常量 `packages/protocol/src/frames.ts`、`packages/protocol/src/constants.ts`（`PROTOCOL_VERSION=1`、`MAX_FRAME_BYTES=65536`、`WINDOW_BYTES=262144`）

### 插件基础

- [x] T012 [P] 实现状态存储 `packages/plugin/src/store.ts`：`schemaVersion` 校验、临时文件 + rename 原子写、文件 0600、损坏文件改名保留，测试 `tests/unit/store.test.ts`
- [x] T013 实现适配层骨架 `packages/plugin/src/adapter.ts`：能力断言（A1/A3/A4），并对外只暴露 `registerRoute()`/`registerUpgradeRoute()`/`getLoopbackOrigin()`/`mintHostCookie()` 四个包装（其它模块不得直接持有 `webServer`/`connection`），`mintHostCookie()` 在 401 时重取一次；测试 `tests/unit/adapter.test.ts`（用 fake webServer/connection）
- [x] T014 [P] 实现契约版本探测 `packages/plugin/src/version.ts`：四项能力断言 + `/api/remote.mux` 存在性探测（期望 401/403 而非 404），失败返回 `disabled` 与原因
- [x] T015 [P] 实现日志脱敏 `packages/plugin/src/redact.ts`：URL 中 `token`/`p/` 段与 cookie 值的掩码规则，测试 `tests/unit/redact.test.ts`

### 隧道与中转

- [x] T016 [P] 实现 Worker 入口路由 `packages/relay/src/index.ts`：`/__dsh_agent` 交 DO、`/__relay/health` 自答、其余路径按 `installId` 转 DO、剥离 `cf-*`/`x-forwarded-*` 请求头
- [x] T017 实现 DO 会话对象 `packages/relay/src/relay-object.ts`：`idFromName(installId)`、hibernatable WebSocket（`acceptWebSocket`）、agent 单例校验、`AGENT_HELLO`/`RELAY_HELLO_ACK` 握手与版本拒绝（`4002`/`4003`）
- [x] T018 实现隧道客户端 `packages/plugin/src/agent.ts`：出站 WSS、首帧 hello、心跳 25s、指数退避（0.5/1/2/5s，±20% 抖动），测试 `tests/unit/agent.test.ts`（本地 WS 替身）
- [x] T019 [P] 落地中转部署配置 `packages/relay/wrangler.toml`：DO binding、`migrations[].new_sqlite_classes`、`workers_dev = true`、`compatibility_date`
- [x] T020 [P] 实现统一错误码与错误页 `packages/plugin/src/errors.ts`、`packages/relay/src/errors.ts`：`protocol`/`protocol-version`/`agent-already-connected`/`backpressure`/`upstream-unreachable`/`quota-exceeded`

**Checkpoint**: 协议可编解码、插件能连上中转并完成握手、状态可安全落盘

---

## Phase 3: User Story 1 - 远程看见并驱动会话（P1）🎯 MVP

**Goal**: 浏览器经中转访问到本机原生 WebUI，能看到实时输出并能提交指令、应答交互

**Independent Test**: 桌面端起一个持续输出的会话，从另一台设备的浏览器经本地 `wrangler dev` 中转打开入口，确认输出持续到达、提交指令后会话继续、远端与本地状态一致

### Tests for US1

- [x] T021 [P] [US1] 断言栅栏改写：`tests/unit/rewrite.test.ts` 覆盖 `Host`/`Origin`/`Referer` 改写、`Cookie` 替换、`sec-fetch-site` 与 `cf-*` 剥离
- [x] T022 [P] [US1] 断言分片与背压：`tests/unit/flow.test.ts` 覆盖 64 KiB 分片、窗口耗尽后暂停、`FLOW_CREDIT` 恢复、超 2× 窗口触发 `backpressure`
- [x] T023 [P] [US1] 集成往返：`tests/integration/http-roundtrip.mjs` 用本地 WS 替身走完 `HTTP_REQUEST_HEAD/BODY/END` → `HTTP_RESPONSE_HEAD/BODY/END`

### Implementation for US1

- [x] T024 [US1] 实现网关 HTTP 流转发 `packages/plugin/src/gateway.ts`：帧 → 对 `getOrigin()` 的 `fetch`，头改写按 `contracts/dsh-adapter.md §2`
- [x] T025 [US1] 实现网关 WS 代理 `packages/plugin/src/gateway.ts`：仅 `/api/remote.mux`，双向转发二进制/文本帧与 close 码
- [x] T026 [US1] 在适配层补 host cookie 注入与 401 重取逻辑 `packages/plugin/src/adapter.ts`（依赖 T013）
- [x] T027 [US1] 中转侧 HTTP 流复用与响应回写 `packages/relay/src/relay-object.ts`（依赖 T017）
- [x] T028 [US1] 中转侧 WS 流与 upgrade 白名单 `packages/relay/src/index.ts`：仅 `/api/remote.mux` 允许升级，其余 404 并关闭 socket
- [x] T029 [US1] 大响应体流式处理 `packages/plugin/src/gateway.ts`：下行边读边发、不整体缓冲、不设硬上限；上行请求体超 25 MiB 回 413
- [x] T030 [US1] 端到端验证脚本 `tests/integration/e2e-remote.test.ts`：起 Host → 起 `wrangler dev` → 无头浏览器加载 → 断言输出到达并提交一条指令

**Checkpoint**: US1 独立可交付——这就是 MVP。此时应立即用 [quickstart.md](quickstart.md) 的场景 4 记录结果。

---

## Phase 4: User Story 2 - 十分钟内从零到可用（P2）

**Goal**: 使用者按文档部署中转、填入地址、扫码配对，看到固定地址与二维码，全程 ≤ 10 分钟

**Independent Test**: 从"未安装插件"开始计时，只做"读文档 → 一条部署命令 → 填地址 → 扫一次码"，直到手机浏览器显示界面

### Tests for US2

- [x] T031 [P] [US2] 单测：中转地址规范化（仅 `https://`、无路径/查询串、末尾斜杠归一），`tests/unit/relay-url.test.ts`
- [x] T032 [P] [US2] 单测：能力链接生成/过期/一次性消费/并发先到者胜，`tests/unit/link.test.ts`

### Implementation for US2

- [x] T033 [US2] 插件配置 schema 与首次启动状态 `packages/plugin/src/config.ts`：`relayUrl` 可空，未配置时状态页显示"未配置中转"
- [x] T034 [US2] 中转地址规范化与校验 `packages/plugin/src/relay-url.ts`（`contracts/status-api.md §3` 的 `invalid-url` 错误码）
- [x] T035 [US2] 握手回传 `relayOrigin` 并据此构造配对入口 `packages/plugin/src/agent.ts`
- [x] T036 [US2] 管理页骨架 `packages/plugin/ui/index.html`，路由经 `adapter.registerRoute("prefix", "/__anywhere/", …)` 注册：未配置中转时展示部署文档链接与完整命令（FR-001），已配置时展示状态
- [x] T037 [P] [US2] 零依赖二维码编码器 `packages/plugin/ui/qr.js`（≤ 8 KB），并在管理页渲染为 canvas
- [x] T038 [US2] 能力链接生成 `packages/plugin/src/link.ts`：32 字节随机、只存 SHA-256、`expiresAt = +10 分钟`、同时最多 1 条 active
- [x] T039 [US2] 配对端点 `/p/:token`：校验（含设备数上限 10 台，超限拒绝并提示）→ 下发设备凭证 → `303 Location: /`，并按 `contracts/relay-http.md §2` 设置 `no-store`/`no-referrer`
- [x] T040 [US2] 部署文档 `docs/relay-setup.md`：含 `npx wrangler deploy --config relay/wrangler.toml`、账号授权、`workers.dev` 地址获取、`/__relay/health` 自检
- [x] T041 [US2] 安装文档 `docs/install.md`：一条命令 `dsh plugin --profile desktop add <本包>`（bundle 自动挂载，无需手改 `cordis.patch.yml`），并给出内置 CLI 的调用方式
- [x] T042 [US2] 将 `packages/plugin` 声明为 bundle（`dsh.bundle.patch` + 自带 `cordis.patch.yml`），使安装在一条命令内完成；已用 `dsh --dump-config` 实测插入项生效

**Checkpoint**: 使用者能独立完成"部署 → 接入 → 扫码"，US1 的能力首次对真实用户可用

---

## Phase 5: User Story 3 - 日常零操作复用（P3）

**Goal**: 配对后长期免操作；多台设备并存且能同时访问；清 cookie 时给出可理解的提示

**Independent Test**: 已配对状态下重启浏览器直接打开入口地址即进入；连续 5 天验证；两台设备同时访问

### Tests for US3

- [x] T043 [P] [US3] 单测：设备模型与持久化（`id` 16 字节、`credentialHash` 只存摘要、`revoked` 保留 7 天），`tests/unit/devices.test.ts`
- [x] T044 [P] [US3] 单测：凭证签发与校验（含错误凭证、已撤销、伪造 token），`tests/unit/auth.test.ts`

### Implementation for US3

- [x] T045 [US3] 设备模型与存储 `packages/plugin/src/devices.ts`，字段与约束按 [data-model.md §Device](data-model.md)
- [x] T046 [US3] 设备凭证签发与每请求实时校验 `packages/plugin/src/auth.ts`：无缓存查表，撤销即拒
- [x] T047 [US3] 浏览器 cookie 下发 `__Host-dshanywhere`（`HttpOnly; Secure; SameSite=Strict; Path=/`，无 `Domain`），仅 TLS 下 `Secure`
- [x] T048 [US3] 多设备并存与并发验证脚本 `tests/integration/lifecycle.test.ts`（≥ 2 台并发访问、互不中断）
- [x] T049 [US3] 隐私模式/清 cookie 的统一 401 提示页 `packages/plugin/src/pages.ts`，文案与"链接无效"页区分；并记录连续 5 天的重复配对次数以验证 SC-004

**Checkpoint**: 日常使用零操作；多设备可并存

---

## Phase 6: User Story 4 - 泄露止损（P4）

**Goal**: 轮换与撤销在界面内一键完成、1 分钟内生效、且不影响其它设备

**Independent Test**: 用已配对设备与未用链接各做一个对照，执行轮换/撤销后确认前者不受影响、后者立即被拒

### Tests for US4

- [x] T050 [P] [US4] 集成测试：轮换只作废未用链接、已配对设备继续可用，`tests/integration/lifecycle.test.ts`
- [x] T051 [P] [US4] 集成测试：撤销后同一凭证的下一个请求即被拒（无缓存延迟），`tests/integration/lifecycle.test.ts`

### Implementation for US4

- [x] T052 [US4] 实现轮换 `packages/plugin/src/auth.ts`：递增 `linkEpoch`、清空未使用链接、不动设备表
- [x] T053 [US4] 实现单设备撤销 `packages/plugin/src/devices.ts`：置 `revoked` 并同步移除内存查表
- [x] T054 [US4] 状态 API 的全部写操作端点（`POST /api/relay`、`/api/link`、`/api/rotate`、`/api/devices/:id/revoke`、`/api/enable|disable`）`packages/plugin/src/status.ts`，路由经 `adapter.registerRoute()`（`contracts/status-api.md §3`）
- [x] T055 [US4] 管理页按钮与二次确认 `packages/plugin/ui/index.html`、`packages/plugin/ui/ui.js`：撤销最后一台设备时提示 `no-active-device`
- [x] T056 [US4] 凭证零外泄审计 `tests/unit/redact.test.ts` 补充：日志、错误页、代理日志三处检索不到令牌明文
- [x] T057 [US4] 安全文档 `docs/security.md`：威胁模型、使用自建中转、**明确不含端到端加密**、轮换与撤销操作

**Checkpoint**: 链接泄露可在 1 分钟内止损

---

## Phase 7: User Story 5 - 状态可见与断线自愈（P5）

**Goal**: 状态页展示连接/地址/设备/统计；远端四类与桌面端两类故障各自可区分；断线 30 秒内自愈

**Independent Test**: 分别制造网络切换、中转重启、桌面端退出、额度受限，确认恢复时间与提示文案

### Tests for US5

- [x] T058 [P] [US5] 单测：访问统计窗口与可访问率计算（成功/失败计数、24 小时滑动），`tests/unit/stats.test.ts`
- [x] T059 [P] [US5] 集成脚本：`tests/integration/recovery.test.ts` 覆盖四种中断并记录恢复秒数

### Implementation for US5

- [x] T060 [US5] 连接状态机与重连调优 `packages/plugin/src/agent.ts`：`idle/connecting/connected/reconnecting/failed` 与失败原因分类（DNS/证书/401/版本）
- [x] T061 [US5] 错误页与分类映射 `packages/plugin/src/pages.ts`、`packages/relay/src/errors.ts`：远端可渲染的四类（电脑端未运行/连接已中断/超时/凭证无效）+ 仅桌面端状态页呈现的两类（中转不可达/额度受限），按 `contracts/relay-http.md §5` 的「呈现位置」列
- [x] T062 [US5] 状态 API 主接口 `GET /__anywhere/api/status` `packages/plugin/src/status.ts`（路由经 `adapter.registerRoute()`）
- [x] T063 [US5] 访问统计 `packages/plugin/src/stats.ts`：只记计数与分类，不记 URL/正文
- [x] T064 [US5] 管理页状态区 `packages/plugin/ui/index.html`、`packages/plugin/ui/ui.js`：连接状态、地址、二维码、设备列表、最近访问、可访问率
- [x] T065 [US5] 把恢复时间与可访问率实测写入 `docs/poc-findings.md`

**Checkpoint**: 五种用户故事全部可独立验证，SC-003/SC-005 有实测数据

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事收尾、文档、合规自检

- [x] T066 [P] 编写 `README.md`：这是什么、组成（插件 + 中转）、三条命令速览、指向 `docs/`
- [x] T067 [P] 文档一致性校对 `docs/**`、`README.md`、`packages/plugin/ui/index.html`：术语（中转/安装/设备/能力链接/设备凭证）全仓统一；VPS/NAS 明确标注"暂不支持"
- [x] T068 版本兼容禁用的端到端验证 `tests/integration/version-probe.test.ts`：模拟能力缺失 → 入口禁用且状态页提示，不出现半可用
- [x] T069 全量 `pnpm run typecheck` + `pnpm test` 通过，无跳过用例
- [x] T070 按 [quickstart.md](quickstart.md) 走完 SC-001~SC-010，结果写入 `docs/poc-findings.md` 的结果表
- [x] T071 按 [Constitution](../../.specify/memory/constitution.md) 逐条自检并把结论写入 `docs/poc-findings.md`
- [x] T072 清理：临时脚本、调试日志、未使用的导出；确认无 `TODO` 残留
- [x] T073 发布形态验证：`dsh plugin --profile desktop add` 安装本地包并冷启动一次
- [x] T074 提交前检查 `packages/**`、`docs/**`、`README.md`：全仓检索无作者域名/账号/Token；无凭证明文；文档语言为简体中文
- [x] T075 [converge 补口] 状态页呈现仅桌面端可见的两类故障（中转不可达 / 额度已用尽），与 FR-013 对齐；`packages/plugin/src/pages.ts` + `tests/unit/pages.test.ts`

---

## Dependencies & Execution Order

### Phase 依赖

```text
Phase 1 (Setup)
    └─▶ Phase 2 (Foundational)  ← T007~T009 若失败需先改方案
            ├─▶ Phase 3 (US1, P1)   MVP
            ├─▶ Phase 4 (US2, P2)
            ├─▶ Phase 5 (US3, P3)
            ├─▶ Phase 6 (US4, P4)
            └─▶ Phase 7 (US5, P5)
                    └─▶ Phase 8 (Polish)
```

### 故事间依赖（有向，不是并行无关）

| 故事 | 前置 | 说明 |
| --- | --- | --- |
| US1 | Phase 2 | 需要协议、适配层、隧道 |
| US2 | Phase 2 + US1 | 配对后可验证"看到界面"，否则无从判断成功 |
| US3 | US2 | 需要已能配对才能谈"长期免配对" |
| US4 | US3 | 轮换/撤销操作对象是设备与链接 |
| US5 | US1 | 状态与恢复依赖隧道与网关 |

> 这与 spec 中"每个故事可独立实现"并不矛盾：故事的价值切片独立，但本特性的**验证链**天然串行（先通、再配对、再持久、再止损、再可观测）。若要并行，US4 与 US5 的实现可同时进行（文件不重叠：`auth.ts`/`devices.ts` vs `pages.ts`/`stats.ts`）。

### 并行机会

- Phase 2：T010/T011（协议）、T012/T014/T015（插件独立模块）、T016/T019/T020（中转独立模块）可并行
- Phase 4：T031/T032 测试与 T037 二维码编码器可并行
- Phase 6 与 Phase 7：`auth.ts`/`devices.ts` 与 `pages.ts`/`stats.ts` 无文件重叠，可两人并行

---

## Implementation Strategy

### MVP 优先

1. 完成 Phase 1 + Phase 2 的 T010~T020（协议/存储/适配/隧道/中转骨架）
2. **先跑 T007~T009 三个 POC**——任一失败则停下来改方案，不要继续写代码
3. 完成 Phase 3（US1），用 `tests/integration/e2e-remote.mjs` 打通"浏览器 → 中转 → 桌面端 → 会话"
4. 此时即为可用的 MVP：能远程看见与驱动，只是配对还靠手工

### 增量交付

- 每次只推进一个 Phase，`npm test` 全绿再进下一个
- 每个 Checkpoint 都按 [quickstart.md](quickstart.md) 对应场景实测一次，结果写进 `docs/poc-findings.md`
- US4 的止损能力**必须**在首次对外发布前完成（Constitution IV 要求"轮换 + 撤销"是 v1 必备）

### 风险前置

| 风险 | 前置任务 |
| --- | --- |
| 平台额度/消息边界不成立 | T007（最先做） |
| 代理下资源路径需改写 | T008 → 需要时在 `adapter.ts` 增加 `rewriteLoopbackUrls` 开关 |
| 安装步骤挤爆 10 分钟预算 | T009 → T042 一键脚本 |
| DSH 契约变更 | T013/T014 的探测与禁用路径 |
