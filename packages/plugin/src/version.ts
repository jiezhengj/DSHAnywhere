/** DSH 0.2.1-rc.5 上实测可用的契约面；任一项缺失即进入 disabled，不做半可用降级 */
export interface HostSurface {
  webServer?: {
    getOrigin?: unknown;
    register?: unknown;
    registerUpgrade?: unknown;
    protocol?: unknown;
  };
  connection?: {
    authenticatedUrl?: unknown;
    admit?: unknown;
  };
  muxPath?: string | null;
}

export type ProbeFailure =
  | "missing-webServer"
  | "missing-getOrigin"
  | "missing-register"
  | "missing-registerUpgrade"
  | "missing-connection"
  | "missing-authenticatedUrl"
  | "missing-mux";

export interface ProbeOk {
  ok: true;
  protocol: string;
}

export interface ProbeErr {
  ok: false;
  reason: ProbeFailure;
  detail: string;
}

export type ProbeResult = ProbeOk | ProbeErr;

/**
 * 探测 DSH 内部契约。四项能力（A1/A3/A4 + mux 端点）缺任一即返回失败，
 * 调用方据此把入口置为 disabled 并提示升级，而不是降级运行。
 */
export function probeHostSurface(surface: HostSurface): ProbeResult {
  const { webServer, connection, muxPath } = surface;
  if (!webServer) {
    return { ok: false, reason: "missing-webServer", detail: "宿主未提供 webServer 服务" };
  }
  if (typeof webServer.getOrigin !== "function") {
    return { ok: false, reason: "missing-getOrigin", detail: "webServer.getOrigin 不可用" };
  }
  if (typeof webServer.register !== "function") {
    return { ok: false, reason: "missing-register", detail: "webServer.register 不可用" };
  }
  if (typeof webServer.registerUpgrade !== "function") {
    return { ok: false, reason: "missing-registerUpgrade", detail: "webServer.registerUpgrade 不可用" };
  }
  if (!connection) {
    return { ok: false, reason: "missing-connection", detail: "宿主未提供 connection 服务" };
  }
  if (typeof connection.authenticatedUrl !== "function") {
    return {
      ok: false,
      reason: "missing-authenticatedUrl",
      detail: "connection.authenticatedUrl 不可用",
    };
  }
  if (!muxPath) {
    return { ok: false, reason: "missing-mux", detail: "未发现 /api/remote.mux 升级端点" };
  }
  const protocol = typeof webServer.protocol === "string" ? webServer.protocol : "http";
  return { ok: true, protocol };
}
