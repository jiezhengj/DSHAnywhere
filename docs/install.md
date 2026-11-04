# 安装与首次配对

## 1. 安装插件（一条命令）

插件以 DSH 的「补丁层（bundle）」形式发布，安装时会自动挂载，**不需要手工编辑**任何配置文件。

```bash
dsh plugin --profile desktop add <本仓库路径或包文件>
```

例如：

```bash
dsh plugin --profile desktop add /Users/you/Project/DSHAnywhere/packages/plugin
```

安装完成后重启一次桌面版。

### desktop 版内置了 CLI

DSH 桌面版自带完整的 `dsh` CLI，只是通常没有加入 `PATH`。macOS 上的调用方式：

```bash
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile desktop add <包路径>
```

Windows 上把前两段换成本机的 `DeepSeek Harness.exe` 与控制台可执行文件即可。

验证是否挂载成功：

```bash
ELECTRON_RUN_AS_NODE=1 "<app>" "<bin.js>" --profile desktop --dump-config | grep dsh-anywhere
```

## 2. 建立中转

见 [relay-setup.md](relay-setup.md)。完成后得到一个 `https://<name>.workers.dev` 地址。

## 3. 配对一台设备

1. 打开桌面版里的「远程接入」页面，确认显示「已连接」。
2. 点「生成配对链接」，页面会出现二维码与链接文本（10 分钟内有效、只能用一次）。
3. 用手机浏览器扫码或直接打开链接：

   - 成功：跳转到干净地址，之后这台设备长期免配对。
   - 失败：一律显示「链接无效或已过期，请在电脑端重新生成」，不区分原因。

## 4. 日常使用

配对后直接打开中转地址即可，无需任何操作。换设备就再生成一次链接；
链接疑似泄露时点「轮换」，旧链接立即失效、已配对的设备不受影响。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 「电脑端未运行」 | 桌面版没开或已退出 | 启动桌面版并保持后台常驻 |
| 「连接已中断」 | 网络切换或中转重启 | 等待自动重连，通常 30 秒内恢复 |
| 桌面端状态页显示「中转不可达」 | 地址填错或 Worker 未部署 | 检查地址与 `wrangler deploy` 结果 |
| 桌面端状态页显示「额度已用尽」 | 免费额度触顶 | 次日自动恢复，或在控制台查看用量 |
