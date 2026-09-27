# CORS proxy on Cloudflare Workers

A small Cloudflare Worker that fetches a public URL for a web page and adds the CORS headers the browser needs. One file, no dependencies, safe by default.

I wrote the first version in an evening in May 2023, so a few browser-only news readers could read feeds that don't send CORS headers. In September 2026 I came back to it, found I had published an open relay, and rewrote it. The write-up is at [sharadbapat.com/experiments/cors-proxy](https://sharadbapat.com/experiments/cors-proxy/).

## Usage

A page on a site you allow asks the Worker for a URL:

```js
const proxy = "https://cors-proxy.<your-subdomain>.workers.dev/";
const res = await fetch(proxy + "?url=" + encodeURIComponent("https://hnrss.org/newest"));
const xml = await res.text();
```

The Worker fetches the URL and returns the body with `Access-Control-Allow-Origin` set to the asking site. The URL it finally reached, after any redirects, comes back in `x-final-url`.

## Refused requests

| Request | Answer | Why |
|---|---|---|
| From a site not in `ALLOWED_ORIGINS`, or with no `Origin` at all | 403 | Otherwise anyone who finds the URL can use it. |
| Anything but `GET`, `HEAD` or the `OPTIONS` preflight | 405 | Reading is the job. Writing to other sites through your account is not. |
| `localhost`, private, link-local or cloud-metadata addresses (`10.x`, `192.168.x`, `169.254.169.254`, `::1`, `fd00::`…) | 403 | These should never be reachable through a public proxy. |
| Ports other than 80 and 443, `user:password@` URLs, anything but `http` and `https` | 400 | Nothing a feed or an API needs. |
| A site not in `ALLOWED_HOSTS`, when you set it | 403 | Limits the proxy to what your page actually uses. |
| Responses over `MAX_BYTES` (5 MB by default) | 413 | It's for feeds, JSON and pages, not video. |
| Sites slower than `TIMEOUT_MS` (10 s by default) | 504 | |
| More than 5 redirects | 508 | Each redirect is checked like the first URL, so a redirect can't smuggle in a private address. |

Cookies and `Authorization` headers are never passed on, and `Set-Cookie` never comes back. Only `Accept`, `Accept-Language`, `If-None-Match`, `If-Modified-Since` and `Range` go upstream. The Worker identifies itself with its own `User-Agent`.

## Settings

| Variable | Default | |
|---|---|---|
| `ALLOWED_ORIGINS` | *(empty: refuse everything)* | Required. Comma-separated sites, e.g. `https://example.com,http://localhost:8080`. `*` opens it to every site; I don't recommend it. |
| `ALLOWED_HOSTS` | *(empty: any public site)* | Optional. Comma-separated hosts it may fetch from. `example.com` also allows `feeds.example.com`. |
| `MAX_BYTES` | `5242880` | Largest response passed through. |
| `TIMEOUT_MS` | `10000` | How long to wait for the site, redirects included. |

## Deploy

With Wrangler (Node 20+):

```sh
git clone https://github.com/sharad-bapat/cors-anywhere-using-cloudflare
cd cors-anywhere-using-cloudflare
# set ALLOWED_ORIGINS (and ALLOWED_HOSTS if you can) in wrangler.jsonc
npm run deploy
```

Or in the Cloudflare dashboard: create a Worker, paste in `worker.js`, and add the variables under Settings, in Variables and Secrets.

To try it locally, put `ALLOWED_ORIGINS="http://localhost:8080"` in a `.dev.vars` file and run `npm run dev`.

## Tests

```sh
npm test
```

16 tests with Node's built-in runner and a stubbed `fetch`: origins, the preflight, methods, private and odd targets, host limits, headers in both directions, redirects, size limits, timeouts and `HEAD`. I also ran it in the local Workers runtime against real sites.

## Bugs in the 2023 version

It was an open relay. It took any site, any method (including `POST`, `PUT` and `DELETE`) and any URL, and answered with `Access-Control-Allow-Origin: *`, so anyone who found a deployment could send any request through it. It also forwarded every request header, cookies and `Authorization` included, to whatever URL it was given.

The User-Agent never reached the site. The README said the Worker set one, but the code put it on the preflight response instead of the outgoing request. And step 4 of the setup said to replace an `https://example.com/` string that wasn't in the code.

Four people starred it and three forked it anyway. If you run a copy of the old version, replace it with this one.

## Limits

- `Origin` only protects you from browsers. A script can send any `Origin` header it likes, so if the Worker's URL is public, set `ALLOWED_HOSTS` too.
- The private-address check looks at the URL, not at DNS. A Worker can't resolve names itself, so a public name that points at a private address isn't caught here. A Worker's requests go out over the public internet, so machines on your own private network aren't reachable from it either way.
- It passes the body through as-is. It doesn't cache, rewrite links or handle logins.

## Licence

MIT. See [LICENSE](LICENSE).
