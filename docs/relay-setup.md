# 建立中转（一条命令）

中转是使用者自己在 Cloudflare 账号下部署的一个 Worker。它是浏览器与电脑之间的固定入口，
不经过作者的服务器，也不需要购买域名。

## 前置条件

- 一个 Cloudflare 账号（免费计划即可）。
- 本机有 Node.js 22 或更新版本（`npx` 随 Node 一起安装）。

## 步骤

1. 在本仓库根目录执行：

   ```bash
   npx wrangler deploy --config relay/wrangler.toml
   ```

2. 首次执行会打开浏览器要求登录 Cloudflare 并授权。授权完成后回到终端等待部署结束。

3. 终端会打印形如下面的地址，记下它：

   ```text
   Deployed dsh-anywhere-relay triggers
     https://dsh-anywhere-relay.<你的子域>.workers.dev
   ```

4. 自检（应返回 `{"ok":true,"protocolVersion":1}`）：

   ```bash
   curl https://dsh-anywhere-relay.<你的子域>.workers.dev/__relay/health
   ```

5. 回到桌面版 DeepSeek Harness 的「远程接入」页面，把上面这个地址填入并保存。

## 免费额度

Cloudflare Workers 免费计划每天 100,000 次请求。日常使用（一次会话里几十到几百次请求）
远低于这个量级；若某天触顶，页面会显示「中转额度已用尽或被限制」，第二天自动恢复。

## 注意事项

- **请使用自己的中转**。中转方在技术上可以看到经过它的流量（TLS 在 Worker 处终止），
  所以不要把别人的中转当作可信边界，本方案也不提供端到端加密。
- 中转只做转发：不保存会话内容、不解析请求正文、不记录凭证。
- 重新部署不会改变地址；若更换了 Worker 名称，地址会变，需要在插件里重新填写。
