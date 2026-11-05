// DSH 内的「远程接入」设置页：配对、设备与开关都在这里，不另开浏览器页面。
// 只使用本机同源的 /__anywhere/api/*；远端（已配对设备）同样走这些接口。
window.__ModuleLoader__.load({
  id: "@dsh-anywhere/plugin",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = "/__anywhere/api";

    const styles = {
      page: { display: "flex", flexDirection: "column", gap: 18, fontSize: 13, lineHeight: 1.6 },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "14px 16px",
        borderRadius: 10,
        border: "1px solid rgba(127,127,127,0.28)",
      },
      row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      hint: { fontSize: 12, opacity: 0.65 },
      button: {
        padding: "5px 12px",
        borderRadius: 6,
        border: "1px solid rgba(127,127,127,0.45)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: 13,
      },
      primary: { borderColor: "rgba(86,140,255,0.8)", color: "#568cff" },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, wordBreak: "break-all" },
      dot: (ok) => ({
        width: 8,
        height: 8,
        borderRadius: 4,
        background: ok ? "#3fbf6a" : "#c9a227",
        display: "inline-block",
      }),
      device: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "6px 0",
        borderTop: "1px solid rgba(127,127,127,0.16)",
      },
    };

    const call = async (path, init) => {
      try {
        const res = await fetch(API + path, init);
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body };
      } catch (err) {
        return { ok: false, status: 0, body: { error: { message: String(err) } } };
      }
    };

    const timeText = (iso) => {
      if (!iso) return "从未";
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t) || t <= 0) return "从未";
      const mins = Math.round((Date.now() - t) / 60000);
      if (mins < 1) return "刚刚";
      if (mins < 60) return `${mins} 分钟前`;
      if (mins < 1440) return `${Math.round(mins / 60)} 小时前`;
      return `${Math.round(mins / 1440)} 天前`;
    };

    function RemoteAccessSection() {
      const [status, setStatus] = useState(null);
      const [pairUrl, setPairUrl] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const canvasRef = useRef(null);

      const refresh = useCallback(async () => {
        const res = await call("/status");
        if (res.ok) setStatus(res.body);
      }, []);

      useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 4000);
        return () => clearInterval(timer);
      }, [refresh]);

      useEffect(() => {
        if (!pairUrl || !canvasRef.current) return;
        let cancelled = false;
        import("/__anywhere/ui/qr.js")
          .then((mod) => {
            if (cancelled || !canvasRef.current) return;
            mod.drawQr(canvasRef.current, mod.encodeQr(pairUrl), 4, 8);
          })
          .catch((err) => setNotice(`二维码绘制失败：${String(err)}`));
        return () => {
          cancelled = true;
        };
      }, [pairUrl]);

      const generate = async () => {
        setBusy(true);
        setNotice(null);
        const res = await call("/link", { method: "POST" });
        setBusy(false);
        if (res.ok && res.body.pairUrl) setPairUrl(res.body.pairUrl);
        else setNotice(res.body?.error?.message ?? "生成失败：请先配置中转地址");
      };

      const rotate = async () => {
        setBusy(true);
        const res = await call("/rotate", { method: "POST" });
        setBusy(false);
        setPairUrl(null);
        setNotice(res.ok ? `已作废 ${res.body.revokedLinks ?? 0} 条未使用链接` : "轮换失败");
        void refresh();
      };

      const disable = async () => {
        setBusy(true);
        await call("/disable", { method: "POST" });
        setBusy(false);
        setPairUrl(null);
        setNotice("已关闭远程接入");
        void refresh();
      };

      const revoke = async (id) => {
        setBusy(true);
        await call(`/devices/${id}/revoke`, { method: "POST" });
        setBusy(false);
        void refresh();
      };

      const copy = async () => {
        if (!pairUrl) return;
        try {
          await navigator.clipboard.writeText(pairUrl);
          setNotice("链接已复制");
        } catch {
          setNotice("复制失败，请手动选中链接");
        }
      };

      const relay = status?.relay ?? {};
      const connected = relay.status === "connected";
      const configured = Boolean(relay.url);
      const devices = (status?.devices ?? []).filter((d) => d.state === "active");

      return h(
        "div",
        { style: styles.page },
        h(
          "div",
          { style: styles.card },
          h(
            "div",
            { style: styles.row },
            h("span", { style: styles.dot(connected) }),
            h("strong", null, configured ? (connected ? "中转已连接" : "中转未连接") : "还没配置中转"),
            h("span", { style: styles.hint }, relay.url ? `${relay.url} · 今日请求 ${relay.requestsToday ?? 0}` : "在中转地址栏填写后保存"),
          ),
          configured ? null : h("div", { style: styles.hint }, "先在自己的 Cloudflare 账号下部署中转，把 wrangler 输出的 https://<name>.workers.dev 地址填到这里。"),
          pairUrl
            ? h(
                "div",
                { style: { ...styles.row, alignItems: "flex-start" } },
                h("canvas", { id: "qr", ref: canvasRef, style: { background: "#fff", borderRadius: 6 } }),
                h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 } },
                  h("div", { style: styles.hint }, "用手机相机扫码；链接 10 分钟内有效且只能用一次。"),
                  h("div", { style: styles.mono }, pairUrl),
                  h(
                    "div",
                    { style: styles.row },
                    h("button", { style: styles.button, onClick: copy, disabled: busy }, "复制链接"),
                    h("button", { style: styles.button, onClick: () => setPairUrl(null), disabled: busy }, "收起"),
                  ),
                ),
              )
            : h(
                "div",
                { style: styles.row },
                h(
                  "button",
                  { style: { ...styles.button, ...styles.primary }, onClick: generate, disabled: busy || !configured },
                  "生成配对链接",
                ),
                h("span", { style: styles.hint }, "生成后在这里直接扫码，不需要另开网页"),
              ),
          notice ? h("div", { style: styles.hint }, notice) : null,
        ),
        h(
          "div",
          { style: styles.card },
          h("strong", null, `已配对设备（${devices.length}/${status?.limits?.maxDevices ?? 10}）`),
          devices.length === 0
            ? h("div", { style: styles.hint }, "还没有已配对的设备")
            : devices.map((d) =>
                h(
                  "div",
                  { key: d.id, style: styles.device },
                  h(
                    "div",
                    null,
                    h("div", null, d.label),
                    h("div", { style: styles.hint }, `最近访问：${timeText(d.lastSeenAt)} · 请求 ${d.requestCount ?? 0} 次`),
                  ),
                  h("button", { style: styles.button, onClick: () => revoke(d.id), disabled: busy }, "撤销"),
                ),
              ),
        ),
        h(
          "div",
          { style: styles.row },
          h("button", { style: styles.button, onClick: rotate, disabled: busy || !configured }, "轮换链接"),
          h("button", { style: styles.button, onClick: disable, disabled: busy || !configured }, "关闭远程接入"),
          h("span", { style: styles.hint }, "轮换会让未使用的链接立刻失效；已配对设备不受影响。"),
        ),
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "remote-access", order: 30, label: "远程接入" },
            RemoteAccessSection,
          ),
        );
      },
    };
  },
});
