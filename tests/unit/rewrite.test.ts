import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterResponseHeaders,
  rewriteRequestHeaders,
  toAbsoluteUrl,
} from "../../packages/plugin/src/rewrite.ts";

const options = { loopbackOrigin: "http://127.0.0.1:50743", hostCookie: "dsh-auth-x=abc" };

test("Host/Origin/Referer 指向 loopback", () => {
  const out = rewriteRequestHeaders(
    { host: "relay.example", origin: "https://relay.example", referer: "https://relay.example/", accept: "text/html" },
    options,
  );
  assert.equal(out.host, "127.0.0.1:50743");
  assert.equal(out.origin, "http://127.0.0.1:50743");
  assert.equal(out.referer, "http://127.0.0.1:50743");
  assert.equal(out.accept, "text/html");
});

test("浏览器 cookie 被替换为宿主 cookie", () => {
  const out = rewriteRequestHeaders({ cookie: "__Host-dshanywhere=secret" }, options);
  assert.equal(out.cookie, "dsh-auth-x=abc");
});

test("平台痕迹与跨站标记被丢弃", () => {
  const out = rewriteRequestHeaders(
    {
      "cf-ray": "abc",
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "1.2.3.4",
      "sec-fetch-site": "cross-site",
      "user-agent": "Mozilla/5.0",
    },
    options,
  );
  assert.equal(out["cf-ray"], undefined);
  assert.equal(out["x-forwarded-for"], undefined);
  assert.equal(out["sec-fetch-site"], undefined);
  assert.equal(out["user-agent"], "Mozilla/5.0");
});

test("上游 Set-Cookie 不转发给浏览器", () => {
  const out = filterResponseHeaders({
    "set-cookie": "dsh-auth-x=abc; Path=/",
    "content-type": "text/html",
    "transfer-encoding": "chunked",
  });
  assert.equal(out["set-cookie"], undefined);
  assert.equal(out["transfer-encoding"], undefined);
  assert.equal(out["content-type"], "text/html");
});

test("相对路径解析到 loopback 绝对地址", () => {
  assert.equal(toAbsoluteUrl("/", options.loopbackOrigin), "http://127.0.0.1:50743/");
  assert.equal(toAbsoluteUrl("/api/remote.mux", options.loopbackOrigin), "http://127.0.0.1:50743/api/remote.mux");
  assert.equal(toAbsoluteUrl("https://x/y", options.loopbackOrigin), "https://x/y");
});

test("转发 WS 握手时丢弃客户端握手头", () => {
  const out = rewriteRequestHeaders(
    {
      "sec-websocket-key": "abc",
      "sec-websocket-version": "13",
      "sec-websocket-extensions": "permessage-deflate",
      connection: "Upgrade",
      upgrade: "websocket",
      "user-agent": "x",
    },
    { loopbackOrigin: "http://127.0.0.1:50743", hostCookie: "dsh-auth-1=2" },
  );
  assert.equal(out["sec-websocket-key"], undefined);
  assert.equal(out.connection, undefined);
  assert.equal(out.upgrade, undefined);
  assert.equal(out.cookie, "dsh-auth-1=2");
  assert.equal(out["user-agent"], "x");
});
