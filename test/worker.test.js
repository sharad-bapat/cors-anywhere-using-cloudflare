// Run with: npm test (Node 20+). No dependencies; the upstream fetch is stubbed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const SITE = "https://sharadbapat.com";
const env = { ALLOWED_ORIGINS: `${SITE}, http://localhost:8080` };
let calls;

// Stub the upstream: each test sets `upstream` to a function returning a Response.
let upstream;
beforeEach(() => {
  calls = [];
  upstream = () => new Response("hello", { headers: { "content-type": "text/plain" } });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return upstream(String(url), init);
  };
});

const ask = (target, { origin = SITE, method = "GET", headers = {}, config = env } = {}) => {
  const query = target === undefined ? "" : `?url=${encodeURIComponent(target)}`;
  const h = new Headers(headers);
  if (origin) h.set("origin", origin);
  return worker.fetch(new Request(`https://proxy.example/${query}`, { method, headers: h }), config);
};

test("serves an allowed origin and echoes it back", async () => {
  const res = await ask("https://example.com/feed.xml");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello");
  assert.equal(res.headers.get("access-control-allow-origin"), SITE);
  assert.equal(res.headers.get("vary"), "Origin");
  assert.equal(res.headers.get("x-final-url"), "https://example.com/feed.xml");
});

test("refuses origins that are not listed, and requests with no origin", async () => {
  assert.equal((await ask("https://example.com/", { origin: "https://evil.example" })).status, 403);
  assert.equal((await ask("https://example.com/", { origin: null })).status, 403);
  assert.equal(calls.length, 0);
});

test("refuses everything when ALLOWED_ORIGINS is not set", async () => {
  assert.equal((await ask("https://example.com/", { config: {} })).status, 403);
});

test("ALLOWED_ORIGINS=* opens it to every site", async () => {
  const res = await ask("https://example.com/", { origin: null, config: { ALLOWED_ORIGINS: "*" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("answers the preflight", async () => {
  const res = await ask("https://example.com/", { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  assert.match(res.headers.get("access-control-allow-headers"), /accept/);
});

test("only GET and HEAD are proxied", async () => {
  const res = await ask("https://example.com/", { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("access-control-allow-origin"), SITE, "the page can read the error");
});

test("asks for a url", async () => {
  const res = await ask(undefined);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /\?url=/);
});

test("refuses local, private and odd targets without fetching them", async () => {
  const refused = [
    "http://localhost/", "http://api.localhost/", "http://printer.local/", "http://127.0.0.1/", "http://2130706433/",
    "http://10.0.0.1/", "http://172.16.5.4/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/", "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/",
    "https://example.com:8443/", "https://user:secret@example.com/", "file:///etc/passwd", "ftp://example.com/", "not a url",
  ];
  for (const target of refused) {
    const res = await ask(target);
    assert.ok(res.status === 400 || res.status === 403, `${target} gave ${res.status}`);
  }
  assert.equal(calls.length, 0);
});

test("ALLOWED_HOSTS limits which sites it fetches, subdomains included", async () => {
  const config = { ...env, ALLOWED_HOSTS: "example.com" };
  assert.equal((await ask("https://example.com/a", { config })).status, 200);
  assert.equal((await ask("https://feeds.example.com/a", { config })).status, 200);
  assert.equal((await ask("https://evil-example.com/a", { config })).status, 403);
  assert.equal((await ask("https://example.com.evil.net/a", { config })).status, 403);
});

test("passes no cookies or credentials upstream, and names itself", async () => {
  await ask("https://example.com/", { headers: { cookie: "session=1", authorization: "Bearer x", accept: "application/json" } });
  const sent = calls[0].init.headers;
  assert.equal(sent.get("cookie"), null);
  assert.equal(sent.get("authorization"), null);
  assert.equal(sent.get("accept"), "application/json");
  assert.match(sent.get("user-agent"), /cors-anywhere-using-cloudflare/);
});

test("passes no cookies back", async () => {
  upstream = () => new Response("ok", { headers: { "set-cookie": "track=1", "content-type": "text/html", etag: '"v1"' } });
  const res = await ask("https://example.com/");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("etag"), '"v1"');
});

test("follows redirects, checking each one", async () => {
  upstream = (url) => url === "https://example.com/old"
    ? new Response(null, { status: 301, headers: { location: "/new" } })
    : new Response("moved here");
  const res = await ask("https://example.com/old");
  assert.equal(await res.text(), "moved here");
  assert.equal(res.headers.get("x-final-url"), "https://example.com/new");

  upstream = () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
  assert.equal((await ask("https://example.com/sneaky")).status, 403);
});

test("gives up after five redirects", async () => {
  upstream = (url) => new Response(null, { status: 302, headers: { location: `${url}x` } });
  assert.equal((await ask("https://example.com/loop")).status, 508);
  assert.equal(calls.length, 6);
});

test("refuses responses over MAX_BYTES, with or without a Content-Length", async () => {
  const config = { ...env, MAX_BYTES: "10" };
  upstream = () => new Response("x".repeat(50), { headers: { "content-length": "50" } });
  assert.equal((await ask("https://example.com/big", { config })).status, 413);

  upstream = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(50))); c.close(); } }));
  const res = await ask("https://example.com/stream", { config });
  await assert.rejects(res.text());
});

test("times out slow sites", async () => {
  upstream = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const res = await ask("https://example.com/slow", { config: { ...env, TIMEOUT_MS: "50" } });
  assert.equal(res.status, 504);
});

test("HEAD returns headers only", async () => {
  const res = await ask("https://example.com/", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(calls[0].init.method, "HEAD");
  assert.equal(res.body, null);
});
