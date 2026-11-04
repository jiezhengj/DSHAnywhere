import { MAX_DEVICES, canPairAnotherDevice, createDevice, deviceLabel } from "./devices.ts";
import { consumeLink } from "./link.ts";
import { renderLinkInvalidPage, renderTooManyDevicesPage } from "./pages.ts";
import type { StoreState } from "./store.ts";
import { BROWSER_COOKIE } from "./rewrite.ts";

export const PAIRING_RE = /^\/p\/([A-Za-z0-9_-]{20,})$/;

export interface PairingOutcome {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** 需要持久化的新状态；undefined 表示无需改动 */
  nextState?: StoreState;
}

export interface PairingOptions {
  now?: number;
  /** 供测试注入；默认取状态里的记录 */
  secure?: boolean;
  maxDevices?: number;
}

function baseHeaders(secure: boolean): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...(secure ? {} : {}),
  };
}

/**
 * 配对端点：校验能力链接 → 下发设备凭证 → 303 到干净地址。
 * 链接一次性：无论成功与否，消费后都不再可用；失败一律给统一措辞。
 */
export function handlePairing(
  path: string,
  state: StoreState,
  options: PairingOptions = {},
): PairingOutcome {
  const now = options.now ?? Date.now();
  const secure = options.secure ?? true;
  const max = options.maxDevices ?? MAX_DEVICES;
  const headers = baseHeaders(secure);

  const match = PAIRING_RE.exec(path);
  if (!match) {
    return { status: 404, headers, body: renderLinkInvalidPage() };
  }
  const token = match[1] ?? "";

  const result = consumeLink(state.link, token, now);
  if (!result.ok) {
    return { status: 401, headers, body: renderLinkInvalidPage() };
  }

  if (!canPairAnotherDevice(state, max)) {
    // 链接已消费但不下发凭证：让使用者先撤销设备
    return {
      status: 403,
      headers,
      body: renderTooManyDevicesPage(max),
      nextState: { ...state, link: null },
    };
  }

  const { device, credential } = createDevice(deviceLabel(state.devices.length), now);
  const cookie = [
    `${BROWSER_COOKIE}=${credential}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");

  return {
    status: 303,
    headers: {
      ...headers,
      location: "/",
      "set-cookie": cookie,
    },
    body: "",
    nextState: {
      ...state,
      link: null,
      devices: [...state.devices, device],
    },
  };
}
