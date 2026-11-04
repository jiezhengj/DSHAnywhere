# 契约：本地管理页与状态 API

**Feature**: `001-browser-remote-access` | **实现位置**: `packages/plugin/src/status.ts` + `packages/plugin/ui/`

管理页只在**本机 loopback** 上可达（寄生在 DSH 已有 listener，`register({kind:"prefix", path:"/__anywhere/"})`）。浏览器远端入口**不暴露**这些接口。

## 1. 访问控制

| 检查 | 规则 |
| --- | --- |
| 来源地址 | `req.socket.remoteAddress` 必须是 loopback（`127.0.0.1`、`::1`）；否则 403 |
| `Host` | 必须是 `127.0.0.1:<port>` / `localhost:<port>`；否则 403 |
| 写操作（POST） | 必须带 `Origin: http://127.0.0.1:<port>`（或 `localhost` 同源）；无 `Origin` 的 POST 一律 403（防 CSRF） |
| 方法 | 未定义的路径与方法一律 404，不回退到 SPA |

## 2. 页面

| 路径 | 内容 |
| --- | --- |
| `GET /__anywhere/` | 单页管理界面（内联 CSS/JS，零外部资源）：中转状态、地址、二维码、设备列表、轮换与撤销按钮、版本兼容提示 |
| `GET /__anywhere/ui.js` | 管理页脚本（纯 ES2020，无构建） |

页面不引入任何 CDN 资源（离线可用、无第三方请求，符合 Constitution II 的"作者零基础设施"精神）。

## 3. 状态 API

所有接口返回 `application/json; charset=utf-8`。响应体中的凭证类字段只在下述"生成"接口出现一次。

### `GET /__anywhere/api/status`

```json
{
  "installation": { "installId": "<base64url>", "state": "ready", "contractVersion": { "expected": "0.2.x", "actual": "0.2.1-rc.5" } },
  "relay": { "url": "https://…workers.dev", "status": "connected", "lastConnectedAt": "…", "requestsToday": 128 },
  "connection": { "state": "connected", "since": "…", "attempt": 0 },
  "devices": [ { "id": "…", "label": "iPhone · 第 1 台", "createdAt": "…", "lastSeenAt": "…", "state": "active", "requestCount": 42 } ],
  "activeLink": { "expiresAt": "…", "consumed": false },
  "stats": { "window": { "since": "…", "success": 120, "failure": 3, "availability": 0.976 } },
  "warnings": [ { "code": "version-incompatible", "message": "…" } ]
}
```

### `POST /__anywhere/api/relay`

请求：`{ "url": "https://<name>.<account>.workers.dev" }`
行为：规范化 → 落盘 → 重建隧道。
返回：`{ "ok": true }` 或 `{ "ok": false, "error": { "code": "invalid-url", "message": "…" } }`

错误码：`invalid-url`（非 https、含路径/查询串）、`unreachable`（握手失败）、`version-mismatch`。

### `POST /__anywhere/api/link`

行为：作废未使用的旧链接 → 生成新令牌（32 字节）→ 返回明文令牌构成的配对地址。
返回：`{ "ok": true, "pairUrl": "https://<relay>/p/<token>", "expiresAt": "…" }`

- 明文只在这次响应里出现，不落盘（落盘的是 SHA-256）。
- 同一时刻最多 1 条 `active` 链接。

### `POST /__anywhere/api/rotate`

行为：递增 `linkEpoch`、作废所有未使用链接；**不动**设备表。
返回：`{ "ok": true, "revokedLinks": 1, "devicesUnaffected": 3 }`

### `POST /__anywhere/api/devices/:id/revoke`

行为：把设备置为 `revoked` 并立刻从内存查找表中移除。
返回：`{ "ok": true }`；设备不存在 → `{ "ok": false, "error": { "code": "not-found" } }`。
若撤销后 `active` 设备数为 0，返回 `{ "ok": true, "warning": "no-active-device" }`（UI 需二次确认才允许）。

### `POST /__anywhere/api/enable`、`POST /__anywhere/api/disable`

行为：用户级开关；`disable` 断开隧道、拒绝新配对，已配对设备访问得 503。
返回：`{ "ok": true }`

## 4. 二维码

- 服务端**不**生成图片：`pairUrl` 由 `/api/link` 返回，二维码在管理页前端用内置的精简 QR 编码器（MIT，≤ 8 KB，随包分发）渲染为 `<canvas>`。
- 理由：避免在插件里引入图片编码依赖或原生模块（Constitution 技术约束：纯 Node）。

## 5. 时序要求（对应 SC）

| 操作 | 必须可见的反馈时长 |
| --- | --- |
| 保存中转地址 → 状态变为 `connecting`/`connected` | ≤ 2 秒 |
| 轮换 / 撤销 → 状态页设备列表与链接状态更新 | ≤ 1 秒 |
| 轮换 / 撤销 → 远端旧凭证被拒绝 | ≤ 60 秒（事实上是下一个请求即生效） |

## 6. 错误统一形态

```json
{ "ok": false, "error": { "code": "string", "message": "面向使用者的简体中文说明" } }
```

`message` 不得包含堆栈、绝对路径、端口细节或任何凭证。
