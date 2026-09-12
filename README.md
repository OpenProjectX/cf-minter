# cf-minter

Solves Cloudflare challenges in a stealth browser and returns the clearance
cookie. The crawler keeps using its ordinary JVM HTTP client; **pages never flow
through this service** — only credentials.

Design, measurements and rationale: [`docs/bt-browser-runtime.md`](../docs/bt-browser-runtime.md).

## API

```
POST /clearance  {"url": "https://www.0mag.net/search?q=x"}
  200  {"host","cookie","ua","attempts","elapsedMs","warm","solvedAt"}
  400  malformed url
  409  challenge not solved — deliberately WITHOUT a cookie; retryable
  501  a gate this service cannot pass (reCAPTCHA / hCaptcha); NOT retryable
  503  browser unavailable

GET  /healthz    process is up
GET  /readyz     a browser actually launched
```

`501` is the useful distinction: a Cloudflare Turnstile that failed is worth
another attempt later, whereas an image CAPTCHA will fail forever and the caller
should treat the source as closed. Detected by frame URL —
`challenges.cloudflare.com` vs `recaptcha/api2` — because the widgets live in
closed shadow roots that CSS cannot reach.

`409` never carries a cookie. A `cf_clearance` taken from an unsolved page looks
identical — right length, right domain — and 403s on first use, which reads as a
stale-cache bug rather than a failed solve.

## Running

```bash
npm install
npm start                       # PORT=8090
```

Measured against live sites: cold mint 30–130 s (sometimes needing retries),
**warm re-validation 820 ms** because the tab still holds a clearance.

## No build step

Node 24 strips the types itself (`node --experimental-strip-types`). That is
*strip-only*: it erases annotations but never emits runtime code, so *parameter
properties* (`constructor(readonly x: T)`), `enum`, `namespace` and decorators
are rejected at load time with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Declare and
assign fields explicitly instead. `npm run typecheck` catches type errors;
only the syntax restriction is invisible to it.

## Configuration

| env | default | notes |
|---|---|---|
| `PORT` | 8090 | |
| `EGRESS_PROXY` | — | **must match the crawler's egress** (see below) |
| `MAX_ATTEMPTS` | 3 | widget clicks before 409 |
| `CLEAR_WAIT_SECONDS` | 20 | wait for a challenge to clear per attempt |
| `MINT_TIMEOUT_MS` | 180000 | ceiling on one mint |
| `MAX_TABS` | 8 | one per gated host, LRU-evicted |
| `BROWSER_MAX_AGE_MS` | 21600000 | recycle to shed state |
| `HEADLESS` | true | `false` to watch it work |

## The one thing that will silently break this

A `cf_clearance` is bound to **(User-Agent, client IP)**. The minter and the
crawler must leave through the same egress, or a cookie minted here is a 403
there — presenting as intermittent flakiness, not as a routing fault. Pin both
to one egress, or point `EGRESS_PROXY` at whatever the crawler uses.

The UA is returned with every cookie for the same reason: send *that* UA, never
a hardcoded one. When the browser binary updates its Chromium, a constant UA
fails everything at once.

## Build

```console
docker build -t cf-minter .
docker run --rm -p 8090:8090 cf-minter
curl localhost:8090/readyz
```

Built on the official `cloakhq/cloakbrowser` image, which carries the stealth
Chromium, Xvfb and an entrypoint that starts X before the command. Node 24 is
lifted in from `node:24-trixie-slim` because the base ships Node 20, which
predates `--experimental-strip-types`, and the sources import each other with
explicit `.ts` extensions.

## Licence boundary

The wrapper code here and the `cloakbrowser` npm client are MIT. The
**CloakBrowser binary** inside the base image is not: it is "free to use, no
redistribution".

Its internal-use clause is explicit that storing and running it in Docker
images, CI runners and internal artifact repositories is permitted for your own
operational purposes. Publishing the built image to a **public** registry is
not - that is redistribution. The GitHub Actions workflow pushes to GHCR, which
for this private repository yields a private package; keep it that way.

The free binary allows one concurrent session, which is why the deployment runs
a single replica. More sessions need a key from cloakbrowser.dev, supplied at
runtime as `CLOAKBROWSER_LICENSE_KEY` - never baked into an image layer.
