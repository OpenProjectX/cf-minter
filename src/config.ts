/** Everything tunable, read once at boot. */
export const config = {
  port: Number(process.env.PORT ?? 8090),

  /**
   * Outbound proxy for the browser.
   *
   * MUST match the crawler's egress: a `cf_clearance` is bound to the client IP
   * that earned it, so a cookie minted through a different egress is a 403 the
   * moment the JVM uses it — and it presents as intermittent flakiness rather
   * than a routing bug. See docs/bt-browser-runtime.md §3.
   */
  proxy: process.env.EGRESS_PROXY || undefined,

  /** Attempts at the widget before giving up and returning 409. */
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),

  /** Seconds to wait for a challenge to clear after each attempt. */
  clearWaitSeconds: Number(process.env.CLEAR_WAIT_SECONDS ?? 20),

  /** Hard ceiling on one mint, including retries. */
  mintTimeoutMs: Number(process.env.MINT_TIMEOUT_MS ?? 180_000),

  /**
   * Open tabs. One per gated host; five hosts is five tabs. Capped so a bug
   * cannot leak tabs into the ~1GB the browser already costs.
   */
  maxTabs: Number(process.env.MAX_TABS ?? 8),

  /**
   * Recycle the browser after this long, to shed accumulated state.
   *
   * Not per request: launching costs 359ms against an ~85s solve, so tearing
   * down between mints would throw away the clearances that make a warm tab
   * 40x faster (§2.4) for no measurable gain.
   */
  browserMaxAgeMs: Number(process.env.BROWSER_MAX_AGE_MS ?? 6 * 60 * 60 * 1000),

  headless: process.env.HEADLESS !== "false",
} as const;
