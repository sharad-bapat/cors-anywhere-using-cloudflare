// A small CORS proxy for Cloudflare Workers.
//
// A web page asks for ?url=<some public URL>; the Worker fetches it and returns it with the
// CORS headers the browser needs. It is safe by default:
//   - only the sites listed in ALLOWED_ORIGINS may use it (browsers send Origin; others are refused)
//   - only GET and HEAD
//   - no cookies or credentials pass through, in either direction
//   - no localhost, private or link-local addresses, no odd ports, no user:password@ URLs
//   - optional ALLOWED_HOSTS to limit which sites it will fetch
//   - limits on size, time and redirects; every redirect is checked like the first URL
//
// Settings (Worker variables): ALLOWED_ORIGINS, ALLOWED_HOSTS, MAX_BYTES, TIMEOUT_MS. See README.md.

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "cors-anywhere-using-cloudflare (+https://github.com/sharad-bapat/cors-anywhere-using-cloudflare)";

// Request headers worth passing on. Everything else, including Cookie and Authorization, is dropped.
const FORWARD_REQUEST_HEADERS = ["accept", "accept-language", "if-none-match", "if-modified-since", "range"];
// Response headers worth passing back. Set-Cookie and the rest are dropped.
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-language", "content-range", "accept-ranges", "cache-control", "etag", "last-modified", "expires"];

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env = {}) {
    const config = readConfig(env);
    const cors = corsHeaders(request.headers.get("origin"), config);

    try {
      if (!cors) throw new Refusal(403, "This proxy only serves the sites it was set up for (ALLOWED_ORIGINS).");
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: preflightHeaders(cors) });
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal(405, "Only GET and HEAD are proxied.");

      const target = new URL(request.url).searchParams.get("url");
      if (!target) throw new Refusal(400, "Add ?url=https://… to say what to fetch.");

      const upstream = await fetchFollowingRedirects(target, request, config);
      const length = Number(upstream.response.headers.get("content-length") || 0);
      if (length > config.maxBytes) throw new Refusal(413, `The response is larger than ${config.maxBytes} bytes.`);

      const headers = new Headers(cors);
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = upstream.response.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set("x-final-url", upstream.url);
      headers.set("x-content-type-options", "nosniff");
      const body = request.method === "HEAD" || !upstream.response.body ? null : upstream.response.body.pipeThrough(byteLimit(config.maxBytes));
      return new Response(body, { status: upstream.response.status, headers });
    } catch (error) {
      const status = error instanceof Refusal ? error.status : error?.name === "TimeoutError" ? 504 : 502;
      const message = error instanceof Refusal ? error.message
        : status === 504 ? `The site took longer than ${config.timeoutMs / 1000}s to answer.`
          : "The site could not be reached.";
      const headers = new Headers(cors || {});
      headers.set("content-type", "text/plain; charset=utf-8");
      return new Response(`${message}\n`, { status, headers });
    }
  },
};

function readConfig(env) {
  const list = (value) => String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const number = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
  return {
    origins: list(env.ALLOWED_ORIGINS).map((origin) => origin.replace(/\/+$/, "")),
    hosts: list(env.ALLOWED_HOSTS),
    maxBytes: number(env.MAX_BYTES, DEFAULT_MAX_BYTES),
    timeoutMs: number(env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

// The CORS headers for an allowed origin, or null if this origin may not use the proxy.
function corsHeaders(origin, config) {
  const open = config.origins.includes("*");
  if (!open && (!origin || !config.origins.includes(origin.toLowerCase()))) return null;
  return {
    "access-control-allow-origin": open ? "*" : origin,
    "access-control-expose-headers": [...FORWARD_RESPONSE_HEADERS, "x-final-url"].join(", "),
    vary: "Origin",
  };
}

function preflightHeaders(cors) {
  return {
    ...cors,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": FORWARD_REQUEST_HEADERS.join(", "),
    "access-control-max-age": "86400",
  };
}

async function fetchFollowingRedirects(target, request, config) {
  const headers = new Headers({ "user-agent": USER_AGENT });
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const signal = AbortSignal.timeout(config.timeoutMs);
  let url = checkTarget(target, config);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(url, { method: request.method, headers, redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) return { response, url: url.href };
    url = checkTarget(new URL(location, url).href, config);
  }
  throw new Refusal(508, `More than ${MAX_REDIRECTS} redirects.`);
}

// Parses and checks a URL the proxy is asked to fetch; throws a Refusal if it may not.
export function checkTarget(value, config) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Refusal(400, "That is not a full URL. It needs to start with https:// or http://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Refusal(400, "Only http and https URLs are proxied.");
  if (url.username || url.password) throw new Refusal(400, "URLs with a username or password are not proxied.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Refusal(400, "Only the standard ports (80 and 443) are proxied.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isPrivateHost(host)) throw new Refusal(403, "Local and private addresses are not proxied.");
  const hostAllowed = !config.hosts.length || config.hosts.includes("*")
    || config.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (!hostAllowed) throw new Refusal(403, "This proxy only fetches from the sites it was set up for (ALLOWED_HOSTS).");
  return url;
}

function isPrivateHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (host.includes(":")) {
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHost(mapped[1]);
    return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  }
  return false;
}

// Passes bytes through until the limit, then fails the stream, so a response without a
// Content-Length header still can't be larger than MAX_BYTES.
function byteLimit(maxBytes) {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) controller.error(new Refusal(413, `The response is larger than ${maxBytes} bytes.`));
      else controller.enqueue(chunk);
    },
  });
}
