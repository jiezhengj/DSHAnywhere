// DSH 设置里的「远程接入」页：配对、设备与中转都在这里，不另开浏览器页面。
// 视觉沿用 DSH 原生设置页的语言：页面标题 + 说明、白卡片、细分隔线、右侧胶囊按钮。
window.__ModuleLoader__.load({
  id: "@dsh-anywhere/plugin",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = "/__anywhere/api";
    // 前端静态资源版本：改动 ui/ 下的脚本时加一，强制拿新的
    const QR_ASSET_VERSION = "2";

    // 只用主题令牌，不写死颜色，浅色/深色都跟随宿主
    const C = {
      label: "var(--dsw-alias-label-primary)",
      sub: "var(--dsw-alias-label-secondary)",
      border: "var(--dsw-alias-border-l1)",
      borderStrong: "var(--dsw-alias-border-l2)",
      brand: "var(--dsw-alias-brand-primary)",
      ok: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      err: "var(--dsw-alias-state-error-primary)",
    };

    const S = {
      page: { height: "100%", overflowY: "auto", color: C.label, fontSize: 13, lineHeight: 1.6 },
      pageInner: {
        maxWidth: 760,
        margin: "0 auto",
        padding: "28px 32px 48px",
        display: "flex",
        flexDirection: "column",
        gap: 20,
      },
      title: { fontSize: 20, fontWeight: 600, letterSpacing: 0.2 },
      description: { color: C.sub, marginTop: 6 },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "14px 16px",
        borderRadius: 12,
        border: `1px solid ${C.border}`,
        background: "var(--dsw-alias-bg-layer-1)",
      },
      cardTitle: { fontSize: 14, fontWeight: 600 },
      rowBetween: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
      rowInline: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      sub: { color: C.sub, fontSize: 12 },
      steps: {
        margin: 0,
        paddingLeft: 20,
        color: C.sub,
        fontSize: 12,
        lineHeight: 1.7,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      },
      mono: { fontSize: 12, color: C.sub, wordBreak: "break-all" },
      pill: {
        border: `1px solid ${C.border}`,
        background: "transparent",
        color: C.label,
        borderRadius: 8,
        padding: "4px 12px",
        fontSize: 13,
        lineHeight: 1.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
      pillPrimary: { color: C.brand, borderColor: C.borderStrong },
      textButton: {
        border: "none",
        background: "transparent",
        color: C.err,
        cursor: "pointer",
        fontSize: 13,
        padding: "4px 2px",
        whiteSpace: "nowrap",
      },
      mutedButton: {
        border: "none",
        background: "transparent",
        color: C.sub,
        cursor: "pointer",
        fontSize: 13,
        padding: "4px 2px",
        whiteSpace: "nowrap",
      },
      dashed: {
        display: "block",
        width: "100%",
        border: `1px dashed ${C.borderStrong}`,
        background: "transparent",
        color: C.sub,
        borderRadius: 12,
        padding: "12px 16px",
        fontSize: 13,
        cursor: "pointer",
        textAlign: "center",
      },
      input: {
        flex: 1,
        minWidth: 0,
        border: `1px solid ${C.border}`,
        background: "transparent",
        color: C.label,
        borderRadius: 8,
        padding: "6px 10px",
        fontSize: 13,
        fontFamily: "inherit",
        outline: "none",
      },
      dot: (color) => ({
        width: 8,
        height: 8,
        borderRadius: 4,
        display: "inline-block",
        background: color,
        flex: "0 0 auto",
      }),
      deviceRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingTop: 10,
        marginTop: 2,
        borderTop: `1px solid ${C.border}`,
      },
      qr: { flex: "0 0 auto", borderRadius: 8, background: "#fff", border: `1px solid ${C.border}` },
    };

    const call = async (path, body) => {
      try {
        const res = await fetch(API + path, {
          method: body === undefined ? "GET" : "POST",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const payload = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body: payload };
      } catch (err) {
        return { ok: false, status: 0, body: { error: { message: String(err) } } };
      }
    };

    const timeText = (iso) => {
      const t = iso ? new Date(iso).getTime() : NaN;
      if (!Number.isFinite(t) || t <= 0) return "从未访问";
      const mins = Math.round((Date.now() - t) / 60000);
      if (mins < 1) return "刚刚访问";
      if (mins < 60) return `${mins} 分钟前访问`;
      if (mins < 1440) return `${Math.round(mins / 60)} 小时前访问`;
      return `${Math.round(mins / 1440)} 天前访问`;
    };

    const formatRemain = (ms) => {
      const total = Math.max(0, Math.round(ms / 1000));
      const mins = Math.floor(total / 60);
      const secs = total % 60;
      return mins > 0 ? `${mins} 分 ${String(secs).padStart(2, "0")} 秒` : `${secs} 秒`;
    };

    const STATE_TEXT = {
      connected: { text: "中转已连接", tone: "ok" },
      connecting: { text: "正在连接中转", tone: "warn" },
      reconnecting: { text: "正在重连中转", tone: "warn" },
      idle: { text: "未连接中转", tone: "warn" },
      unreachable: { text: "中转不可达", tone: "err" },
    };

    function Button(props) {
      const style = props.variant === "primary" ? { ...S.pill, ...S.pillPrimary } : S.pill;
      return h("button", { type: "button", style, disabled: props.disabled, onClick: props.onClick }, props.children);
    }

    function RemoteAccessPanel() {
      const [status, setStatus] = useState(null);
      const [pair, setPair] = useState(null); // { url, expiresAt }
      const [tick, setTick] = useState(() => Date.now());
      const [draftUrl, setDraftUrl] = useState("");
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const canvasRef = useRef(null);

      const refresh = useCallback(async () => {
        const res = await call("/status");
        if (res.ok) setStatus(res.body);
      }, []);

      useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 5000);
        return () => clearInterval(timer);
      }, [refresh]);

      // 每秒走一格，用来显示链接剩余有效期
      useEffect(() => {
        if (!pair) return undefined;
        const timer = setInterval(() => setTick(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [pair]);

      useEffect(() => {
        if (!pair || !canvasRef.current) return;
        let cancelled = false;
        // 带上版本号，避免页面模块缓存住旧编码器
        import(`/__anywhere/ui/qr.js?v=${QR_ASSET_VERSION}`)
          .then((mod) => {
            if (cancelled || !canvasRef.current) return;
            mod.drawQr(canvasRef.current, mod.encodeQr(pair.url));
          })
          .catch((err) => setNotice(`二维码绘制失败：${String(err)}`));
        return () => {
          cancelled = true;
        };
      }, [pair]);

      const act = async (path, body) => {
        setBusy(true);
        const res = await call(path, body ?? {});
        setBusy(false);
        return res;
      };

      const configure = async () => {
        const url = draftUrl.trim();
        if (!url) return;
        const res = await act("/relay", { url });
        if (res.ok) {
          setNotice(null);
          setDraftUrl("");
          void refresh();
        } else {
          setNotice(res.body?.error?.message ?? "保存失败，请检查地址");
        }
      };

      const generate = async () => {
        const res = await act("/link");
        if (res.ok && res.body.pairUrl) {
          setPair({ url: res.body.pairUrl, expiresAt: res.body.expiresAt ?? null });
          setTick(Date.now());
          setNotice(null);
        } else {
          setNotice(res.body?.error?.message ?? "生成失败，请确认中转已连接");
        }
      };

      const reconnect = async () => {
        if (!relay.url) return;
        const res = await act("/relay", { url: relay.url });
        setNotice(res.ok ? "已重新连接中转" : "重连失败，请检查网络或重新部署中转");
        void refresh();
      };

      const rotate = async () => {
        const res = await act("/rotate");
        setPair(null);
        setNotice(res.ok ? `已作废 ${res.body.revokedLinks ?? 0} 条未使用链接` : "轮换失败");
        void refresh();
      };

      const disable = async () => {
        await act("/disable");
        setPair(null);
        setNotice("已关闭远程接入");
        void refresh();
      };

      const revoke = async (id) => {
        await act(`/devices/${id}/revoke`);
        void refresh();
      };

      const copy = async () => {
        if (!pair) return;
        try {
          await navigator.clipboard.writeText(pair.url);
          setNotice("链接已复制");
        } catch {
          setNotice("复制失败，请手动选中链接");
        }
      };

      const relay = status?.relay ?? {};
      const configured = Boolean(relay.url);
      const state = STATE_TEXT[relay.status] ?? { text: "状态未知", tone: "warn" };
      const toneColor = state.tone === "ok" ? C.ok : state.tone === "err" ? C.err : C.warn;
      const expiresAtMs = pair?.expiresAt ? new Date(pair.expiresAt).getTime() : 0;
      const remainingMs = pair ? Math.max(0, expiresAtMs - tick) : 0;
      const expired = Boolean(pair) && expiresAtMs > 0 && remainingMs <= 0;
      const remainText = formatRemain(remainingMs);
      const activeLinkMs = status?.activeLink?.expiresAt ? new Date(status.activeLink.expiresAt).getTime() : 0;
      const activeLinkRemain = activeLinkMs > tick ? activeLinkMs - tick : 0;
      const devices = (status?.devices ?? []).filter((d) => d.state === "active");
      const maxDevices = status?.limits?.maxDevices ?? 10;

      return h(
        "div",
        { style: S.page },
        h(
          "div",
          { style: S.pageInner },

        // 标题区：与「内置插件」等页面一致，标题 + 一句话说明
        h(
          "div",
          null,
          h("div", { style: S.title }, "远程接入"),
          h(
            "div",
            { style: S.description },
            "把这台电脑通过你自己的 Cloudflare 中转开放给你自己，用手机或别的电脑继续操作。",
          ),
        ),

        // 中转配置 / 状态
        configured
          ? h(
              "div",
              { style: S.card },
              h(
                "div",
                { style: S.rowBetween },
                h(
                  "div",
                  { style: S.rowInline },
                  h("span", { style: S.dot(toneColor) }),
                  h("span", { style: S.cardTitle }, state.text),
                ),
                h(
                  "div",
                  { style: S.rowInline },
                  relay.status === "connected"
                    ? null
                    : h(Button, { onClick: reconnect, disabled: busy }, "重新连接"),
                  h(Button, { onClick: rotate, disabled: busy }, "轮换链接"),
                ),
              ),
              h("div", { style: S.mono }, relay.url),
              h(
                "div",
                { style: S.sub },
                `今日请求 ${relay.requestsToday ?? 0} 次 · 已配对 ${devices.length}/${maxDevices} 台设备`,
              ),
            )
          : h(
              "div",
              { style: S.card },
              h("div", { style: S.cardTitle }, "连接你自己的中转"),
              h(
                "div",
                { style: S.sub },
                "中转是你在自己 Cloudflare 账号下部署的一个 Worker，浏览器和这台电脑都只连它。配置之前不会建立任何外部连接。",
              ),
              h(
                "ol",
                { style: S.steps },
                h("li", null, "在本项目根目录执行 npx wrangler deploy --config packages/relay/wrangler.toml"),
                h("li", null, "首次执行会打开浏览器，登录并授权你的 Cloudflare 账号"),
                h("li", null, "部署完成后终端会打印 https://<名称>.<子域>.workers.dev，粘贴到下面"),
              ),
              h(
                "div",
                { style: { ...S.rowInline, flexWrap: "nowrap" } },
                h("input", {
                  style: S.input,
                  value: draftUrl,
                  placeholder: "https://<名称>.<子域>.workers.dev",
                  spellCheck: false,
                  onChange: (event) => setDraftUrl(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") void configure();
                  },
                }),
                h(Button, { variant: "primary", onClick: configure, disabled: busy }, "保存"),
              ),
            ),

        // 配对：默认是一条虚线主操作，生成后展开成二维码卡片
        pair
          ? h(
              "div",
              { style: S.card },
              h(
                "div",
                { style: S.rowBetween },
                h(
                  "div",
                  { style: S.rowInline },
                  h("div", { style: S.cardTitle }, "扫码配对"),
                  expired
                    ? h("span", { style: { ...S.sub, color: C.err } }, "已过期")
                    : h("span", { style: S.sub }, `剩余 ${remainText}`),
                ),
                h(
                  "div",
                  { style: S.rowInline },
                  h(Button, { variant: "primary", onClick: generate, disabled: busy }, "重新生成"),
                  h(Button, { onClick: copy, disabled: busy || expired }, "复制链接"),
                  h(Button, { onClick: () => setPair(null), disabled: busy }, "收起"),
                ),
              ),
              h(
                "div",
                { style: { ...S.rowInline, alignItems: "flex-start", gap: 14, flexWrap: "nowrap" } },
                h("canvas", { ref: canvasRef, style: expired ? { ...S.qr, opacity: 0.28 } : S.qr }),
                h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 } },
                  h("div", { style: S.sub }, "用手机相机扫码打开，或把链接发到要加载的设备上。"),
                  h("div", { style: S.mono }, pair.url),
                  expired
                    ? h("div", { style: { ...S.sub, color: C.err } }, "这条链接已过期，点「重新生成」换一条新的。")
                    : h("div", { style: S.sub }, "链接一次性使用，过期后重新生成即可。"),
                ),
              ),
            )
          : h(
              "button",
              {
                type: "button",
                style: { ...S.dashed, cursor: configured ? "pointer" : "not-allowed", opacity: configured ? 1 : 0.55 },
                onClick: generate,
                disabled: busy || !configured,
              },
              configured ? "＋ 生成配对链接" : "＋ 配置中转后即可生成配对链接",
            ),
        !pair && activeLinkRemain > 0
          ? h(
              "div",
              { style: S.sub },
              `已有一条没用掉的配对链接（${formatRemain(activeLinkRemain)}后过期）。出于安全这里不回显，重新生成会立刻替换它。`,
            )
          : null,

        // 设备
        h(
          "div",
          { style: S.card },
          h(
            "div",
            { style: S.rowBetween },
            h("div", { style: S.cardTitle }, "已配对设备"),
            h("div", { style: S.sub }, `${devices.length}/${maxDevices}`),
          ),
          devices.length === 0
            ? h("div", { style: S.sub }, "还没有设备。生成配对链接后扫码即可加入。")
            : devices.map((device) =>
                h(
                  "div",
                  { key: device.id, style: S.deviceRow },
                  h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
                    h("div", null, device.label),
                    h("div", { style: S.sub }, `${timeText(device.lastSeenAt)} · 请求 ${device.requestCount ?? 0} 次`),
                  ),
                  h(
                    "button",
                    { type: "button", style: S.textButton, onClick: () => revoke(device.id), disabled: busy },
                    "撤销",
                  ),
                ),
              ),
        ),

        notice ? h("div", { style: S.sub }, notice) : null,

        // 页脚：关掉整个入口
        configured
          ? h(
              "div",
              { style: { ...S.rowInline, justifyContent: "flex-end" } },
              h("button", { type: "button", style: S.mutedButton, onClick: disable, disabled: busy }, "关闭远程接入"),
            )
          : null,
        ),
      );
    }

    // 侧边栏图标：显示器 + 手机，表示“这台电脑从别处接入”。
    // 宿主只按设置项 id 映射图标，自定义设置项拿不到图标位，所以入口放在主界面的面板列表里。
    function RemoteAccessIcon(props) {
      const size = (props && props.size) || 16;
      const active = Boolean(props && props.active);
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: active ? 1.15 : 1,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { flex: "0 0 auto" },
        },
        h("rect", { x: 1, y: 2.2, width: 8.4, height: 6.2, rx: 1.2 }),
        h("path", { d: "M5.2 8.4v2.2" }),
        h("path", { d: "M3.5 10.6h3.4" }),
        h("rect", { x: 10.8, y: 5.2, width: 3.8, height: 8.6, rx: 1.1 }),
        h("path", { d: "M9.4 5.4h1.4" }),
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // 主界面左侧面板：图标由我们自己画，点开就是整页管理界面
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: "remote-access", order: 20, label: "远程接入" },
            RemoteAccessIcon,
          ),
        );
        ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "remote-access" }, RemoteAccessPanel));
      },
    };
  },
});
