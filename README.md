# DSHAnywhere

把桌面版 DeepSeek Harness 的界面搬到手机浏览器里：桌面端跑一个进程，出门在外用任意浏览器打开一个固定地址，就能继续用同一台电脑上的会话。

不需要公网 IP，不需要开放入站端口，不需要在手机上装任何东西。

# 组成

只有两块，都在这个仓库里：

| 组成 | 位置 | 作用 |
| --- | --- | --- |
| 插件（桌面端） | `packages/plugin` | 挂进 DSH，把本机 WebUI 通过出站 WebSocket 送到中转，并管理配对、设备与状态 |
| 中转（Cloudflare Worker） | `packages/relay` | 你自己账号下的一个 Worker，给浏览器一个固定地址，把请求转发到桌面端 |

协议层在 `packages/protocol`，两端共用帧格式与错误码。

# 三条命令速览

```bash
# 1. 装插件（bundle 自动挂载，不用手改配置）
dsh plugin --profile desktop add <本仓库的 packages/plugin>

# 2. 部署你自己的中转，记下返回的 https://<name>.workers.dev
npx wrangler deploy --config relay/wrangler.toml

# 3. 桌面端点「生成配对链接」，手机扫码
```

完整步骤见 [安装文档](docs/install.md) 与 [中转部署](docs/relay-setup.md)。

# 安全边界

- 中转**能看到明文**：TLS 在 Worker 处终止，v1 **不提供端到端加密**。请使用自己的中转。
- 设备凭证只存 SHA-256，每个请求实时校验，撤销立即生效。
- 详见 [安全模型](docs/security.md)。

# 文档

- [安装与首次配对](docs/install.md)
- [建立中转](docs/relay-setup.md)
- [安全模型](docs/security.md)
- [POC 实测记录](docs/poc-findings.md)
- 规格与设计：`specs/001-browser-remote-access/`

# 当前状态

已完成：协议与帧编解码、插件网关（HTTP/WS 转发、401 换发重试）、中转 Worker/DO、配对与设备凭证、轮换与撤销、状态页与断线自愈、零依赖二维码。

**暂不支持**：VPS、NAS 等自建宿主的原生部署（只支持 Cloudflare Workers 中转形态）。

真实 Cloudflare 部署与真实手机扫码的端到端验证仍待完成，见 `docs/poc-findings.md` 的「未验证」小节。
