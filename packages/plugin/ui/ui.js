// 管理页交互：生成配对链接、轮换、关闭、撤销设备。
// 只在本机管理页加载；所有写操作都走 /__anywhere/api/*。
(function () {
  const api = async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const drawPairing = (pairUrl) => {
    const canvas = document.getElementById("qr");
    if (!canvas || !window.DSHAnywhereQr) return;
    const matrix = window.DSHAnywhereQr.encodeQr(pairUrl);
    window.DSHAnywhereQr.drawQr(canvas, matrix, 4, 8);
  };

  const showPairing = (pairUrl) => {
    const block = document.getElementById("pairing-block");
    if (!block) return;
    let code = block.querySelector(".pairing");
    if (!code) {
      const hint = document.getElementById("pairing-hint");
      if (hint) hint.remove();
      code = document.createElement("p");
      code.innerHTML = '配对链接：<code class="pairing"></code>';
      block.insertBefore(code, block.firstChild);
      code = block.querySelector(".pairing");
    }
    code.textContent = pairUrl;
    drawPairing(pairUrl);
  };

  document.getElementById("generate-link")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { status, json } = await api("/__anywhere/api/link");
      if (status === 200 && json.ok) showPairing(json.pairUrl);
      else alert(json?.error?.message || "生成失败，请先配置中转地址");
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("rotate")?.addEventListener("click", async () => {
    if (!confirm("轮换会使所有未使用的配对链接立即失效，已配对设备不受影响。继续？")) return;
    const { json } = await api("/__anywhere/api/rotate");
    if (json.ok) alert(`已作废 ${json.revokedLinks} 条未使用链接，${json.devicesUnaffected} 台设备不受影响`);
  });

  document.getElementById("disable")?.addEventListener("click", async () => {
    if (!confirm("关闭后已配对设备将无法访问，确认关闭？")) return;
    await api("/__anywhere/api/disable");
    location.reload();
  });

  document.querySelectorAll("[data-revoke]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("撤销后该设备需要重新配对才能访问。继续？")) return;
      const id = button.getAttribute("data-revoke");
      const { json } = await api(`/__anywhere/api/devices/${encodeURIComponent(id)}/revoke`);
      if (json.warning === "no-active-device" && !confirm("这是最后一台设备，撤销后将没有任何设备可访问。仍要撤销？")) {
        return;
      }
      location.reload();
    });
  });

  document.querySelectorAll(".pairing").forEach((node) => drawPairing(node.textContent));
})();
