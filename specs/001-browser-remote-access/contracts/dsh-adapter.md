# 契约：插件与 DSH 内部契约的适配层

**Feature**: `001-browser-remote-access` | **实现位置**: `packages/plugin/src/adapter.ts`（唯一允许 `import` `@deepseek-ai/*` 的文件）

DSH 没有对外稳定的插件 API，本文件把"我们依赖了什么"写成可审查的清单。任何一条发生变化，只需改 `adapter.ts`，其余模块不受影响。

## 1. 依赖清单（实证，`app.asar` 0.2.1-rc.5）

| # | 能力 | 实际接口 | 用途 |
| --- | --- | --- | --- |
| A1 | 注册 HTTP 路由 | `webServer.register({ kind: "exact" \| "prefix", path, handler })` → disposer | 状态页与状态 API |
| A2 | 注册升级路由 | `webServer.registerUpgrade({ path, handler(req, socket, head) })` | 预留：v1 不需要新开 WS 端点 |
| A3 | 读取监听信息 | `webServer.getOrigin()` → `http://127.0.0.1:<port>`、`webServer.port`、`webServer.protocol` | 构造 loopback 目标与 `Host`/`Origin` 改写值 |
| A4 | 换发 host cookie | `connection.authenticatedUrl(baseUrl)` → 带 `?token=` 的 URL | 在进程内换取可长期复用的 host cookie |
| A5 | 升级端点事实 | `dsh-api-gateway` 在精确路径 `/api/remote.mux` 注册升级处理 | 网关只代理这一个 WS 路径 |
| A6 | 栅栏与诊断 | 401/403 语义、`admit()` 前置检查 | 让转发请求"看起来"来自 loopback |

**不依赖**：不 `import` DSH 的 store、session、permission、UI 包；不读取 `app.asar`；不打补丁。

## 2. 请求改写规则

浏览器请求进入网关后，必须按下表改写再发往 `getOrigin()`：

| 头 | 改写为 | 理由 |
| --- | --- | --- |
| `Host` | `127.0.0.1:<port>` | 栅栏要求 loopback；且 cookie 的 `authority` 绑定 `hostname:port` |
| `Origin` | `http://127.0.0.1:<port>`（HTTP 无此头则不加） | 栅栏要求同源 |
| `Referer` | `http://127.0.0.1:<port><path>` 或删除 | 同上，且避免泄露中转地址 |
| `Cookie` | 仅注入换发好的 host cookie；**丢弃**浏览器带来的 `__Host-dshanywhere` | 浏览器凭证不得进入 DSH |
| `sec-fetch-site` | 删除 | 浏览器标的是 `same-origin`（对中转），但语义对 DSH 已不成立 |
| `x-forwarded-for` / `cf-*` | 删除 | 防止把中转的接入信息当成信任输入 |
| `Accept-Encoding` | 保留 | 压缩由 DSH 自行决定 |

响应方向：

| 头 | 处理 |
| --- | --- |
| `Set-Cookie`（DSH 下发的 `dsh-auth-*`） | **剥离**（远端不需要，也不应看到） |
| `Set-Cookie`（插件自己下发的 `__Host-dshanywhere`） | 保留 |
| `Location` | 相对路径保留；若为绝对 `http://127.0.0.1:<port>/…` 则改写为相对路径 |
| `Content-Length` | 保留（分片在协议层，不改变 HTTP 语义） |

## 3. host cookie 的获取与续期

```text
启动 / 需要时：
  url = connection.authenticatedUrl(webServer.getOrigin())
  res = await fetch(url, { redirect: "manual" })        // 期望 303 + set-cookie
  cookie = res.headers.getSetCookie()[0] 的首段
  缓存 cookie 到内存（含 DSH 返回的 Max-Age）
```

- 请求返回 401 时，说明 cookie 失效（DSH 重启后签名密钥变化，或超过 30 天），此时**静默重取一次**并重放该请求；重取失败才向浏览器返回 502。
- 重取最多 1 次/请求，避免放大故障。
- cookie 明文只存在于内存，不写日志、不落盘（Constitution IV）。

## 4. 升级（WebSocket）转发

- 浏览器对 `/api/remote.mux` 的 upgrade → 网关向 `ws://127.0.0.1:<port>/api/remote.mux` 建本地 WS，携带改写后的 `Host`、`Origin`、注入的 host cookie。
- 双向二进制/文本帧原样转发；`close` 码与原因双向传递。
- 本地 WS 建不起来（ECONNREFUSED）→ 回 502 并提示"电脑端未运行"。

## 5. index 与静态资源

- v1 **不改写 HTML**：假设原生 WebUI 在根路径代理下资源引用可用。
- POC 若证伪（出现指向 `127.0.0.1:<port>` 的绝对 URL），回退方案：用 `webServer.tapIndex(transform)` 注入一段最小修正脚本（把绝对 loopback URL 改写为相对路径），并把它作为适配层的独立开关 `rewriteLoopbackUrls`。
- 静态资源不参与任何改写；`Cache-Control` 原样透传。

## 6. 版本探测（FR-027）

启动顺序：

1. `assertCapability("webServer.register")`、`("webServer.registerUpgrade")`、`("webServer.getOrigin")`、`("connection.authenticatedUrl")`；
2. 读取宿主 `dshVersion`（`app`/`ctx.version` 等可用来源，缺失即视为 `unknown`）；
3. 断言升级端点存在：在本地发起一次 `GET /api/remote.mux` 的普通请求，期望 401/403 而非 404（存在但拒绝 ≠ 不存在）；
4. 全部通过 → `Installation.state = "ready"`；任一失败 → `"disabled"`，状态页显示"当前 DSH 版本不兼容（期望 0.2.x，实测 <ver>）"，并**不建立隧道**。

探测结果写入 `state.json`，便于事后排障；不得因探测失败而静默半启动。

## 7. 生命周期

| 时机 | 行为 |
| --- | --- |
| 插件加载 | 探测 → 读状态 → 若已配置中转则建立隧道 |
| Host 关闭 | 关闭隧道（发送 `WS_CLOSE` 1001），冲刷状态文件 |
| 用户停用 | 断开隧道、停止接受新配对；已配对设备访问得到 503 |
| 用户删除插件 | 状态目录保留（含设备凭证摘要）；文档说明如何清理 |

## 8. 禁止事项（Constitution I）

- 不得修改 DSH 的任何包、源码或权限档位。
- 不得新起 Host 进程去驱动同一会话（单写者租约）。
- 不得在网关里实现"只读""只允许某些工具"之类的模式。
- 不得缓存会话内容或请求/响应体到磁盘。
