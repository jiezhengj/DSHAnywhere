# Idea Intake: DSHAnywhere — 用浏览器远程查看并驱动桌面版 DeepSeek Harness 会话

- **Slug**: dsh-anywhere
- **Created**: 2026-11-04
- **Source**: pasted text（本会话对话记录）；辅以本机 DeepSeek Harness Desktop 安装目录的只读查证线索（见「线索」）
- **Type**: new-capability

## Idea (as captured)

> 那么，如果我希望你做一个插件（工作区我选错了，如果要做这个插件，工作区请放在 "C:\Users\<you>\Documents\Project\DSHAnywhere"）：
> 目的很简单，如果 DeepSeek Harness 正在跑任务，但我不在电脑边上，又想看我电脑里 DeepSeek Harness 的任务执行情况、想要驱动会话，就用浏览器，远程登录这个 webui。你觉得可行吗？可以是什么方案？
> 我在外用的设备，既可能在局域网内，也可能在局域网外，但我不想在那个设备上安装并运行 Tailscale 才能访问这个 webui。

## Restated

希望为桌面版 DeepSeek Harness 提供一个可选的远程访问插件：当本机任务正在执行时，用户能从局域网内或公网外的浏览器查看任务进展，并继续驱动已有的会话；远端设备不安装 Tailscale 一类客户端。

## Origin & Context

- **Raised by**: 项目所有者
- **Trigger**: 人在电脑外（局域网内或局域网外）时，无法获知或驱动本机正在运行的 DeepSeek Harness 任务；当前桌面版的 Web 界面只监听本机回环地址，外部设备无法直接访问。

### 线索（本会话内只读查证的事实，供 research 阶段核对来源）

- 桌面版是 Electron 外壳加载一套内置的 dsh runtime（`app.asar`，本机版本 0.2.1-rc.5），桌面窗口承载的正是同一套 Web UI。
- 桌面 Host 以固定参数 `--host 127.0.0.1 --port 0` 启动，因此只监听回环地址且端口随机；外部设备即使在同一局域网也无法直连。
- 浏览器侧认证模型：每进程一个随机启动令牌，`GET /?token=…` 换取绑定 hostname+port 的签名 cookie；`/api` RPC 与 WebSocket 均要求该 cookie；另有 Host/Origin 信任栅栏。
- 会话持久化使用内核级单写者租约（POSIX `flock`；Windows 命名内核信号量），因此另起一个 Host 进程无法驱动桌面进程已持有的会话——远程访问必须指向桌面那个 Host 进程本身。
- 桌面窗口关闭后隐藏到系统托盘，Host 继续运行，因此应用在后台常驻期间可被访问。
- 安装包内未包含 Tailscale、cloudflared、ngrok 等任何隧道客户端集成。
- 桌面 profile 的用户补丁层（`~/.dsh/profiles/desktop/cordis.patch.yml`）已有第三方插件行，说明该 Host 进程内可以挂载插件。
- 现有公网接入候选：Cloudflare Tunnel、自建 VPS + frp / SSH 反向隧道、经 NAS 中转、路由器端口映射 + DDNS（远端设备均无需安装客户端）。
- 当前权限预设为 `danger-full-access` + `approval: never`，即经 Web UI 登录后具备本机完全执行能力。

## First-Glance Unknowns

- [NEEDS CLARIFICATION: 公网接入走哪条路径——Cloudflare Tunnel（需在本机安装 cloudflared）、自建 VPS + frp、经现有 NAS 中转、路由器端口映射 + DDNS，还是先只做局域网访问？]
- [NEEDS CLARIFICATION: 认证强度要求——密码 + TOTP、仅密码 + 外层 Cloudflare Access，是否接受单密码即可？]
- [NEEDS CLARIFICATION: 是否拥有可用于固定 HTTPS 域名的域名，证书由谁签发与管理？]
- [NEEDS CLARIFICATION: 远端设备主要是手机浏览器还是桌面浏览器，可接受的最小屏幕宽度是多少？]
- [NEEDS CLARIFICATION: 是否接受「桌面应用必须保持运行、电脑不休眠不关机」这一前提，还是需要额外的常驻/自启形态？]
- [NEEDS CLARIFICATION: 远程可执行的操作范围是否需要收窄（例如只读观察、禁止危险工具），还是与本地完全等价？]
- [NEEDS CLARIFICATION: 是否需要多设备/多用户同时接入，以及审计日志的保留期要求？]
- [NEEDS CLARIFICATION: 期望的首次可用时间与可投入的维护成本（桌面端升级后需要跟进适配的容忍度）？]
