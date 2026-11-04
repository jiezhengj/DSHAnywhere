import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntime } from "../../packages/plugin/src/index.ts";
import { Gateway } from "../../packages/plugin/src/gateway.ts";
import { RelayBridge } from "../../packages/relay/src/bridge.ts";
import type { HttpSink } from "../../packages/relay/src/bridge.ts";
import { authenticate, readCookie } from "../../packages/plugin/src/auth.ts";
import { BROWSER_COOKIE } from "../../packages/plugin/src/rewrite.ts";
import { decodeFrame } from "../../packages/protocol/src/index.ts";

function host() {
  const routes: { kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }[] = [];
  return {
    host: {
      webServer: {
        getOrigin: () => "http://127.0.0.1:50743",
        register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }) => {
          routes.push(route);
          return () => {};
        },
        registerUpgrade: () => () => {},
        protocol: "http",
      },
      connection: { authenticatedUrl: (b: string) => b, admit: () => true },
      muxPath: "/api/remote.mux",
    },
    routes,
  };
}

function fakeReq(method: string, url: string, body = "") {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  return {
    method,
    url,
    headers: {},
    on(event: string, cb: (...a: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      if (event === "data" && body) setTimeout(() => cb(body), 0);
      if (event === "end") setTimeout(() => cb(), 1);
    },
  };
}

function fakeRes() {
  const state: { status?: number; headers: Record<string, string>; body: string } = { headers: {}, body: "" };
  return {
    state,
    res: {
      set statusCode(v: number) {
        state.status = v;
      },
      setHeader(n: string, v: string) {
        state.headers[n.toLowerCase()] = v;
      },
      end(body?: string) {
        state.body = body ?? "";
      },
    },
  };
}

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), "dshanywhere-life-"));
  const h = host();
  const rt = createRuntime(h.host, { relayUrl: "https://relay.example" }, {
    storageDir: dir,
    createSocket: () => ({ send: () => {}, close: () => {}, addEventListener: () => {} }),
  });
  const call = async (method: string, url: string, body = "") => {
    const captured = fakeRes();
    for (const r of h.routes) {
      if (url.startsWith(r.path)) {
        await r.handler(fakeReq(method, url, body), captured.res);
        return captured.state;
      }
    }
    throw new Error(`未匹配路由：${url}`);
  };
  return { rt, call };
}

async function pairDevice(call: (m: string, u: string, b?: string) => Promise<{ body: string; headers: Record<string, string> }>) {
  const link = await call("POST", "/__anywhere/api/link");
  const token = JSON.parse(link.body).pairUrl.split("/p/")[1];
  const paired = await call("GET", `/p/${token}`);
  const credential = (paired.headers["set-cookie"] ?? "").split(";")[0]!.split("=")[1]!;
  return { credential, token };
}

test("轮换后旧链接失效，已配对设备仍可用", async () => {
  const { rt, call } = await runtime();
  const { credential, token } = await pairDevice(call);
  assert.equal(authenticate(rt.state(), credential).ok, true);

  // 再生成一条未使用的链接，轮换应把它作废
  await call("POST", "/__anywhere/api/link");
  assert.ok(rt.state().link);
  const rotated = await call("POST", "/__anywhere/api/rotate");
  assert.equal(JSON.parse(rotated.body).revokedLinks, 1, "轮换前应有 1 条未用链接");
  assert.equal(rt.state().link, null);

  assert.equal(authenticate(rt.state(), credential).ok, true, "设备不受影响");

  const replay = await call("GET", `/p/${token}`);
  assert.equal(replay.status, 401, "已消费的链接依然无效");
});

test("撤销后同一凭证的下一个请求即被拒", async () => {
  const { rt, call } = await runtime();
  const { credential } = await pairDevice(call);
  const deviceId = rt.state().devices[0]!.id;
  assert.equal(authenticate(rt.state(), credential).ok, true);

  await call("POST", `/__anywhere/api/devices/${deviceId}/revoke`);
  assert.equal(authenticate(rt.state(), credential).ok, false, "无缓存延迟");
});

test("disable 后设备被拒且隧道不重建，enable 后恢复", async () => {
  const { rt, call } = await runtime();
  const { credential } = await pairDevice(call);
  await call("POST", "/__anywhere/api/disable");
  const denied = authenticate(rt.state(), credential);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.reason, "disabled");
  await call("POST", "/__anywhere/api/enable");
  assert.equal(authenticate(rt.state(), credential).ok, true);
});

test("两台设备可并发访问且帧流互不干扰", async () => {
  const { rt, call } = await runtime();
  const a = await pairDevice(call);
  const b = await pairDevice(call);
  assert.equal(rt.state().devices.length, 2);

  const server = createServer((req, res) => {
    const delay = req.url === "/slow" ? 30 : 0;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${req.url}-${String(req.headers.cookie ?? "")}`);
    }, delay);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let relay!: RelayBridge;
  const gateway = new Gateway({
    loopbackOrigin: origin,
    mintHostCookie: async () => "dsh-auth-x=t",
    send: (bytes) => {
      const frame = decodeFrame(bytes);
      queueMicrotask(() => relay.onFrame(frame));
    },
    authorize: (headers) => {
      const credential = readCookie(headers, BROWSER_COOKIE);
      const result = authenticate(rt.state(), credential);
      return result.ok ? "ok" : result.reason;
    },
  });
  relay = new RelayBridge({
    send: (bytes) => {
      const frame = decodeFrame(bytes);
      queueMicrotask(() => void gateway.onFrame(frame));
    },
    close: () => {},
  });

  const request = (path: string, credential: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      let status = 0;
      const chunks: Uint8Array[] = [];
      const sink: HttpSink = {
        head: (s) => {
          status = s;
        },
        body: (c) => chunks.push(c),
        end: () => {
          const total = chunks.reduce((n, c) => n + c.byteLength, 0);
          const joined = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            joined.set(c, off);
            off += c.byteLength;
          }
          resolve({ status, body: new TextDecoder().decode(joined) });
        },
        fail: (code) => reject(new Error(code)),
      };
      relay.request({ method: "GET", path, headers: { cookie: `${BROWSER_COOKIE}=${credential}` } }, null, sink);
    });

  const [first, second, third] = await Promise.all([
    request("/slow", a.credential),
    request("/fast", b.credential),
    request("/", a.credential),
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.match(first.body, /\/slow-dsh-auth-x=t/);
  assert.match(second.body, /\/fast-dsh-auth-x=t/);
  await new Promise<void>((r) => server.close(() => r()));
});

test("未配对设备拿到 401 而不是 loopback 内容", async () => {
  const { rt } = await runtime();
  const server = createServer((_req, res) => res.end("secret"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let relay!: RelayBridge;
  const gateway = new Gateway({
    loopbackOrigin: origin,
    mintHostCookie: async () => "dsh-auth-x=t",
    send: (bytes) => {
      const frame = decodeFrame(bytes);
      queueMicrotask(() => relay.onFrame(frame));
    },
    authorize: (headers) => {
      const credential = readCookie(headers, BROWSER_COOKIE);
      const result = authenticate(rt.state(), credential);
      return result.ok ? "ok" : result.reason;
    },
  });
  relay = new RelayBridge({ send: (b) => queueMicrotask(() => void gateway.onFrame(decodeFrame(b))), close: () => {} });

  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    let status = 0;
    const chunks: Uint8Array[] = [];
    const sink: HttpSink = {
      head: (s) => {
        status = s;
      },
      body: (c) => chunks.push(c),
      end: () => resolve({ status, body: new TextDecoder().decode(chunks[0] ?? new Uint8Array()) }),
      fail: (code) => reject(new Error(code)),
    };
    relay.request({ method: "GET", path: "/", headers: {} }, null, sink);
  });

  assert.equal(result.status, 401);
  assert.match(result.body, /这台设备还没有配对/);
  assert.doesNotMatch(result.body, /secret/);
  await new Promise<void>((r) => server.close(() => r()));
});
