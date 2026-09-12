# Browser runtime — design and implementation

Written 2026-09-08, **implemented 2026-09-09** as [`cf-minter/`](../cf-minter/)
plus `ClearedHttpFetcher` / `HttpClearanceProvider` on the crawler side. Supersedes the sketch in
[`bt-fetch-strategy.md`](bt-fetch-strategy.md) §7, which predates both the
implementation and the discovery that 0mag walls us too.

Every mechanism below was validated against the three live Cloudflare-gated
sites, not designed on paper. The measurements are in §2.

---

## 1. What this is, and what it is not

**It is a credential minter.** A small service that solves a Cloudflare
challenge in a real browser and hands back a `cf_clearance` cookie plus the
User-Agent that earned it. The crawler keeps using its ordinary JVM HTTP client.

**It is not a fetching proxy.** Pages never flow through it. That was settled by
measurement (`bt-fetch-strategy.md` §1) and re-confirmed here: a minted cookie
replays over plain `curl` for both search and detail pages on all three walled
sites. Routing crawl traffic through a browser would cost ~1 GB of RAM and
roughly 10x the latency per page, to obtain bytes a socket can already fetch.

| | browser-per-request | **minter (chosen)** |
|---|---|---|
| RAM per concurrent fetch | ~0.5–1 GB | ~0 (JVM socket) |
| latency per page | seconds | one HTTP round trip |
| browser invocations per 1,000 pages | 1,000 | **~1** |
| blast radius when it breaks | all crawling stops | gated sources stop; open ones continue |

## 2. Validated mechanism

A headless CloakBrowser launched with `humanize=True`, pointed at the challenge
URL, waiting out the non-interactive challenge and clicking the widget if a
managed one appears:

| site | solved | attempts | wall time | cookie replays over plain curl |
|---|---|---|---|---|
| **0mag.net** | yes | 1 | ~30 s | **yes** — search *and* detail pages, HTTP 200 |
| **bt4gprx.com** | yes | 1 | 58 s | yes |
| **damag.net** | yes | 3 | 70 s | yes |

Budget **30–130 s for a cold solve, and expect failures**: a later run over the
same sites took 85 s for 0mag and failed bt4g outright at 131 s before
succeeding on a retry 76 s later (§2.4). All runs returned a 597-byte cookie and
the same UA, `Chrome/146.0.0.0` — the binary's own.

Treat solving as slow and fallible, not as a request-time operation. That is
what §5's "retry exactly once, then back off 6 h" is sized against.

### 2.1 The cookie's `expires` is a lie — do not build a TTL on it

Every minted cookie carried `expires` **one year out** (`ttl=8760.0h`), and
`httpOnly=true`. Cloudflare invalidates server-side long before that, on its own
schedule, and gives no signal of when.

So the cache must be **reactively invalidated, never expiry-driven**: use a
cookie until a request comes back challenged, then re-mint. A conservative soft
TTL (say 20 minutes) is a hint to refresh early, not a correctness mechanism.
An earlier note put the lifetime at "~30 min"; that was inferred from the token
format and should not be treated as measured.

### 2.2 Runtime: Node/TypeScript, in-process — not `cloakserve` over CDP

**CloakBrowser has first-class TypeScript support.** The npm package
(`cloakbrowser@0.5.10`) is written in TS, ships `.d.ts` for every entry point,
and exports `./`, `./puppeteer` and `./human`. `humanize` is a first-class
option there (`types.ts: humanize?: boolean`, `playwright.ts: humanizeBrowser`),
with the same preset/config surface as Python and a Puppeteer variant too.

An earlier draft of this section said the minter had to be Python because
"humanize is Python-only". **That was wrong** — it conflated *wrapper vs CDP*
with *Python vs JS*. Verified by minting from TypeScript:

```ts
import { launch } from "cloakbrowser";
const browser = await launch({ headless: true, humanize: true });
```

run with `node --experimental-strip-types mint.ts`, which produced a valid
597-byte `cf_clearance` for 0mag that then returned **HTTP 200 over plain
`curl`**, with the same `Chrome/146.0.0.0` UA as the Python path.

The real constraint stands, and it is about the transport, not the language:
**the solve must run in-process through the wrapper's patched Playwright**, not
over CDP. `cloakserve` keeps the stealth fingerprint intact over CDP
(`webdriver:false`, `platform:Win32`, 5 plugins from a Linux host) but cannot
carry `humanize`, and without it the managed-Turnstile click does not land.
Cloudflare renders the widget inside **nested closed shadow roots** —
`document.querySelectorAll('iframe').length == 0` while `page.frames().length == 2` —
so `frame_locator` with CSS, frame-by-URL plus a checkbox locator, and
`get_by_role` all fail. What works is a `body`/coordinate click **inside the
challenge frame**, and it must be tried *before* `input[type=checkbox]`, which
otherwise burns a 30 s timeout.

So: **a Node/TypeScript service importing `cloakbrowser` directly.**

### 2.3 Only ever return a cookie from a *solved* page

The probe captured cookies before checking `solved`, and bt4g's cold attempt
failed after 3 tries. The cookie taken from that unsolved page looked
plausible — 597 bytes, right domain — and returned **403** on replay.

A `cf_clearance` is not evidence of clearance. The minter must return `409`
when the challenge is unsolved rather than hand back a cookie that fails on
first use and looks like a stale-cache bug.

### 2.4 Keep the browser warm — but for the right reason

Measured over two hosts, minting cold then re-validating on the same tabs:

| step | time |
|---|---|
| browser launch | **359 ms** |
| cold mint, 0mag | 85.5 s |
| **warm re-validate, 0mag** | **2.1 s** |
| cold mint, bt4g | 130.6 s (`solved=false`, 3 attempts) |
| warm retry, bt4g | 76.4 s (`solved=true`) |

Two conclusions, and the first is not the obvious one:

1. **Launch is not the cost.** 359 ms against an 85 s solve. Keeping the browser
   alive to avoid start-up would be optimising 0.4% of the work.
2. **Keeping the *context* alive is worth 40x**, because a warm tab still holds
   a valid clearance and there is simply no challenge to solve — 2.1 s instead
   of 85 s. It is a cookie cache that happens to have a browser attached, which
   is what makes re-solving in place cheap when it does go stale.

Note also that bt4g failed cold and succeeded warm. **Solve success is not
100%**, so a long-lived tab that can retry later is a better shape than a
one-shot process that either wins or fails the request.

#### Shape

- **One browser, one context, one tab per host.** Cookies are per-domain, so a
  single context is correct; separate tabs keep each host's navigation and
  challenge state independent, and make "re-validate host X" a cheap isolated
  action.
- **The tab is the cache.** A mint request navigates the host's existing tab: no
  challenge means an immediate hit, a challenge means solve in place.
- **Recycle on a schedule, not per request.** Relaunch periodically, or when a
  host's solves start failing, to shed accumulated state — but never between
  mints.
- **Bounded tabs.** Five gated hosts is five tabs; cap it with LRU eviction so a
  bug cannot leak tabs into the ~1 GB budget.

## 3. Egress affinity — the constraint that silently breaks everything

`cf_clearance` is bound to **(User-Agent, client IP)**. Measured: the same cookie
with `Chrome/140` instead of the minting `Chrome/146` returns **403**; with no
cookie, 403.

Two hard consequences:

1. **The minter and the crawler must leave through the same egress IP.** In
   Kubernetes with several nodes and per-node SNAT, a cookie minted on node A is
   worthless to a fetcher on node B — and the symptom is an *intermittent*
   403 that looks like flakiness, not a routing bug. Pin both to one egress: a
   shared egress gateway, an explicit outbound proxy configured on both
   (`cloakbrowser.launch(proxy=...)` takes one), or colocation.
2. **The UA travels with the cookie.** The crawler must send the UA the minter
   reports, never a constant. When the binary updates its Chromium, the UA moves
   and a hardcoded one fails everything at once. `JdkHttpFetcher.DEFAULT_UA` is
   currently `Chrome/146.0.0.0` by coincidence of matching — that coincidence is
   not a design.

## 4. The minter service

Deliberately tiny: one endpoint that does one slow thing.

```
POST /clearance        {"url": "https://www.0mag.net/search?q=x"}
  200 {"host":"www.0mag.net","cookie":"<cf_clearance>","ua":"Mozilla/5.0 …",
       "solvedAt":"2026-09-08T12:00:00Z","attempts":1,"elapsedMs":31500}
  409 {"error":…,"kind":"turnstile","retryable":true}    # never a cookie (§2.3)
  501 {"error":…,"kind":"recaptcha","retryable":false}   # a gate we cannot pass
  503 {"error":"browser unavailable"}

GET  /healthz          liveness: the process is up
GET  /readyz           readiness: a browser launched successfully at boot
```

A URL rather than a bare host, because the challenge is often attached to a
specific path (0mag challenged `/search` before the whole site).

**Single-flight per host** is the property that matters most. A solve takes up
to 70 s; if twenty fetches hit a 403 at once, twenty solves must not start.
Concurrent requests for the same host await one in-flight solve.

Sketch, matching the validated probe (Node 24 runs `.ts` directly with
`--experimental-strip-types`, so no build step is required):

```ts
import { launch } from "cloakbrowser";
import type { Browser, BrowserContext, Page } from "playwright-core";

let browser: Browser;              // long-lived: launch is 359ms, solves are ~85s
let ctx: BrowserContext;           // holds the clearances — this is the cache
const tabs = new Map<string, Page>();   // one per host, LRU-capped

async function mint(url: string): Promise<Clearance> {
  const host = new URL(url).host;
  return singleFlight(host, async () => {          // never N solves for one host
    const page = await tabFor(host);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    for (let attempt = 0; attempt < 3; attempt++) {
      await waitWhileChallenged(page, 20);         // non-interactive self-clears
      if (!(await challenged(page))) break;
      const frame = page.frames().find(f => f.url().includes("challenges.cloudflare.com"));
      await frame?.locator("body").first().click({ timeout: 5000 }).catch(() => {});
      await waitWhileChallenged(page, 20);
    }

    if (await challenged(page)) throw new Unsolved(host);   // 409, never a cookie
    const cookie = (await ctx.cookies()).find(c => c.name === "cf_clearance"
      && host.endsWith(c.domain.replace(/^\./, "")));
    if (!cookie) throw new Unsolved(host);
    return { cookie: cookie.value, ua: await readUa(page) };
  });
}
```

Three details the probe taught, each of which cost a run:

- **Read the UA defensively.** Right after a solve the page is often
  mid-navigation and `page.evaluate` throws *"Execution context was destroyed"*.
- **`body` before `input[type=checkbox]`** — the checkbox selector cannot reach
  into the closed shadow root and costs a 30 s timeout on the way to failing.
- **Match the cookie domain to the host.** With one shared context holding
  several sites' cookies, `cookies().find(name === "cf_clearance")` returns
  whichever came first.

## 5. Crawler-side integration

The seam already exists. `HttpFetcher` is a `fun interface` in `core`, and
`ZeroMagSource` takes one — so this is a decorator, not a rewrite, and `core`
gains no dependency.

```kotlin
/** A cookie plus the UA that earned it. They are only valid together (§3). */
data class Clearance(val cookie: String, val userAgent: String)

interface ClearanceProvider {
    fun current(url: String): CompletionStage<Clearance>
    /** Discard the cached clearance and mint a new one. */
    fun refresh(url: String): CompletionStage<Clearance>
}

/**
 * Wraps a fetcher so gated hosts carry a clearance, and one challenge triggers
 * exactly one re-mint and one retry.
 */
class ClearedHttpFetcher(
    private val clearances: ClearanceProvider,
    private val build: (Clearance) -> HttpFetcher,
) : HttpFetcher {
    override fun get(url: String): CompletionStage<String> =
        clearances.current(url)
            .thenCompose { build(it).get(url) }
            .exceptionallyCompose { failure ->
                if (failure.cause is MagnetSourceBlockedException) {
                    clearances.refresh(url).thenCompose { build(it).get(url) }
                } else CompletableFuture.failedStage(failure)
            }
}
```

Wiring is one branch in `MagnetProducer`:

```kotlin
"0mag" -> ZeroMagSource(
    fetcher = if (cfg.minterUrl().isPresent) ClearedHttpFetcher(provider, ::jdkFetcherFor)
              else JdkHttpFetcher(),
)
```

**Retry exactly once.** A second challenge after a fresh cookie means the site is
refusing this identity, not that the cookie was stale — retrying again just
burns solves. Let it surface as `MagnetSourceBlockedException`, which the engine
already handles: `blocked-backoff` (6 h) and the row stays eligible.

That existing behaviour is what makes this safe to add incrementally. Today a
blocked source yields `failed`, never `empty` — verified live — so a missing or
broken minter degrades to "these rows are retried later", never to "these titles
have no magnets".

## 6. Deployment

A third deployment beside `api` and `worker`: stateless, no cron, its own
lifecycle.

```yaml
cfMinter:
  enabled: false                  # off until a gated source is enabled
  replicaCount: 1                 # see concurrent-session monitoring, below
  image:
    repository: ghcr.io/openprojectx/cf-minter   # INTERNAL registry only
  resources:
    requests: {cpu: 500m, memory: 1Gi}
    limits:   {memory: 2Gi}
  env:
    EGRESS_PROXY: ""              # must match the crawler's egress (§3)
```

| concern | decision | why |
|---|---|---|
| memory | request 1Gi, limit 2Gi | measured ~935 MB RSS for one session |
| `/dev/shm` | no volume needed | `--disable-dev-shm-usage` is already in the args |
| replicas | 1, raise deliberately | the binary reports **concurrently open sessions** for licence checks; and more replicas means more egress IPs unless pinned |
| image | internal registry only | the licence permits internal Docker images, forbids redistribution |
| base image | Node 24 on the CloakBrowser image | the service is TS; the image already carries the binary, Xvfb and Node 20+ |
| browser lifetime | one per pod, recycled on a timer | launch is 359 ms, so recycling is cheap; the reason to keep it is the retained clearance (§2.4) |
| probes | `/readyz` launches a browser once at boot | a container whose Chromium cannot start otherwise looks healthy and fails every request |
| Xvfb | keep the image's entrypoint | it already handles the stale `/tmp/.X99-lock` that breaks `docker restart` |
| timeouts | crawler-side call timeout > 90 s | a solve can take 70 s and retry |

**Dev loop:** none of this is needed to work on the crawler. filemood and snowfl
are unwalled, and `crawler.magnet.minter-url` unset means `JdkHttpFetcher` as
today. Add the container to `compose-devservices.yml` only when working on a
gated source.

## 7. Failure modes

Every one of these has been seen, and none should read as "no magnets":

| symptom | cause | handling |
|---|---|---|
| 403 with `Just a moment` | no/stale clearance | re-mint, retry once |
| HTTP **200** with `<title>Security Check</title>` | bt4g's second, site-level gate | content check already raises `MagnetSourceBlockedException` |
| 200 with `One moment...` and empty body | filemood's interstitial | retry; unrelated to clearance |
| intermittent 403 across pods | **egress mismatch** (§3) | pin egress; do not "fix" with more retries |
| 403 immediately after a good mint | UA drift | send the minter's UA, never a constant |
| every request 403, minter healthy | site raised its bar | back off 6 h; re-evaluate the source |
| solve loops 3 attempts | fingerprint burned | rotate identity, or accept the source is closed for now |
| `501 kind:recaptcha` | an **image CAPTCHA**, not a bot-detection challenge | not retryable at any cadence: a stealth fingerprint has nothing to beat. Treat the source as closed (btdig.com, §5b of bt-search-api.md) |

## 8. As built

Verified end to end against the Cloudflare-walled 0mag:

```
POST /magnets/dmm/drain?magnetSource=0mag
  {"source":"0mag","claimed":4,"matched":4,"empty":0,"failed":0,"elapsedMs":26303}
```

Four titles enriched from a site that returns 403 to plain `curl`, with the JVM
using its ordinary HTTP client throughout. 22 magnets landed, the rollup
columns populated, and the filters answered:

```
?hasMagnet=true   -> SONE-846  6 magnets [SUB_ZH, UNCENSORED]
?magnet=UNCENSORED -> 4
?minRes=1080&sort=magnets -> SONE-871(6), IPZZ-736(5), IPZZ-688(5)
```

The minter logged **one** cold mint (48s, 2 attempts) for four rows: the JVM's
per-host single-flight collapsed the rest onto it, as intended.

| piece | where |
|---|---|
| minter service | `cf-minter/src/{index,browser,singleflight,config}.ts` |
| image | `cf-minter/Dockerfile`, on the CloakBrowser base |
| deployment | `deploy/helm/acrawler/templates/deployment-cf-minter.yaml`, `cfMinter.*` values |
| clearance seam | `core/.../magnet/Clearance.kt` — `Clearance`, `ClearanceProvider`, `ClearedHttpFetcher` |
| minter client | `app/.../magnet/HttpClearanceProvider.kt` |
| wiring | `crawler.magnet.minter-url`, `crawler.magnet.enable-zero-mag` |

### 8.1 Two things the build changed about the design

**Source selection.** With more than one magnet source configured, `/refresh`
and `/drain` were silently using whichever was first. Both now take
`?magnetSource=`, and an unknown name is an error rather than a quiet
substitution.

**`refresh-timeout` cannot cover a cold mint.** It was 25s; a cold solve is
30-130s, so an on-demand refresh of a gated title always timed out. Raised to
45s, which covers an unwalled lookup and a *warm* clearance (820ms) but
deliberately not a cold mint — an interactive caller should not be held two
minutes. A cold gated refresh times out, the row is queued with priority
raised, and the drainer (no such ceiling) finishes it. That is the documented
behaviour now, not an accident.

## 9. What is still unknown

- **Real cookie lifetime under load.** The `expires` attribute is useless (§2.1)
  and the server-side rule is unpublished. Measure re-mint frequency in
  production; it sets the browser's duty cycle and therefore the replica count.
- **Whether 0mag's threshold is per-IP or per-identity.** It walled us after a
  few hundred requests and stayed walled; whether a fresh fingerprint from the
  same IP clears it is untested, and the answer decides whether rotation helps.
- **Solve success rate over time.** Three sites, one solve each, is not a rate.
  If it drops, the free binary (v146) versus the current Pro build is the first
  lever.
