import { launch } from "cloakbrowser";
import type { Browser, BrowserContext, Frame, Page } from "playwright-core";
import { config } from "./config.ts";

export type Clearance = {
  host: string;
  cookie: string;
  ua: string;
  attempts: number;
  elapsedMs: number;
  /** True when the tab was already clear and no challenge had to be solved. */
  warm: boolean;
};

/** The challenge could not be cleared. Never accompanied by a cookie. */
export class Unsolved extends Error {
  // Declared and assigned explicitly rather than as a constructor parameter
  // property: Node's strip-only type stripping can erase types but cannot emit
  // the assignment a parameter property implies, and rejects the syntax.
  readonly kind: GateKind;

  constructor(host: string, attempts: number, kind: GateKind = "turnstile") {
    super(`challenge not solved for ${host} after ${attempts} attempts (gate: ${kind})`);
    this.name = "Unsolved";
    this.kind = kind;
  }
}

/**
 * A gate this service cannot pass, however many times it tries.
 *
 * Worth its own type because the caller's response differs: a Turnstile that
 * failed is worth retrying later, whereas an image CAPTCHA will fail forever
 * and the source should simply be considered closed.
 */
export class Unsupported extends Error {
  readonly kind: GateKind;

  constructor(host: string, kind: GateKind) {
    super(`${host} is behind a ${kind} challenge, which this service cannot solve`);
    this.name = "Unsupported";
    this.kind = kind;
  }
}

export type GateKind = "none" | "turnstile" | "recaptcha" | "hcaptcha";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A long-lived stealth browser with one tab per host.
 *
 * Two measurements shape this (docs/bt-browser-runtime.md §2.4). Launching costs
 * **359ms** against an **~85s** cold solve, so keeping the process alive to skip
 * start-up would be optimising 0.4% of the work. What is worth keeping is the
 * *context*: a warm tab still holds a valid clearance, so re-validating a host
 * took **2.1s instead of 85s**. The browser is a cache that can re-solve in
 * place, not a way to avoid `launch()`.
 */
export class BrowserPool {
  private browser?: Browser;
  private ctx?: BrowserContext;
  private bornAt = 0;
  private readonly tabs = new Map<string, Page>();

  async ready(): Promise<void> {
    await this.context();
  }

  private async context(): Promise<BrowserContext> {
    if (this.ctx && Date.now() - this.bornAt < config.browserMaxAgeMs) return this.ctx;
    if (this.ctx) await this.close("recycling");

    // humanize is what makes the managed-Turnstile click land, and it only
    // exists in-process — it does not travel over CDP (§2.2).
    this.browser = (await launch({
      headless: config.headless,
      humanize: true,
      ...(config.proxy ? { proxy: config.proxy } : {}),
    })) as Browser;
    this.ctx = await this.browser.newContext();
    this.bornAt = Date.now();
    this.tabs.clear();
    return this.ctx;
  }

  async close(reason: string): Promise<void> {
    if (!this.browser) return;
    console.log(JSON.stringify({ msg: "closing browser", reason }));
    await this.browser.close().catch(() => {});
    this.browser = undefined;
    this.ctx = undefined;
    this.tabs.clear();
  }

  private async tabFor(host: string): Promise<Page> {
    const ctx = await this.context();
    const open = this.tabs.get(host);
    if (open && !open.isClosed()) {
      // Refresh LRU position.
      this.tabs.delete(host);
      this.tabs.set(host, open);
      return open;
    }

    while (this.tabs.size >= config.maxTabs) {
      const [oldest, page] = this.tabs.entries().next().value as [string, Page];
      this.tabs.delete(oldest);
      await page.close().catch(() => {});
    }

    const page = await ctx.newPage();
    this.tabs.set(host, page);
    return page;
  }

  /** Solve if needed and return the clearance. Throws {@link Unsolved} if not. */
  async mint(url: string): Promise<Clearance> {
    const started = Date.now();
    const host = new URL(url).host;
    const page = await this.tabFor(host);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    let attempts = 0;
    // A non-interactive challenge clears itself; wait before touching anything.
    await this.waitWhileChallenged(page);

    // Fail fast on a gate no amount of clicking will open. Without this an
    // image CAPTCHA burns three attempts and then reports a generic "not
    // solved", which reads like a transient failure worth retrying — it is not.
    const gate = await detectGate(page);
    if (gate === "recaptcha" || gate === "hcaptcha") throw new Unsupported(host, gate);

    const warm = !(await challenged(page));
    while (attempts < config.maxAttempts && (await challenged(page))) {
      attempts++;
      await clickWidget(page);
      await this.waitWhileChallenged(page);
    }

    if (await challenged(page)) throw new Unsolved(host, attempts);

    const ctx = await this.context();
    const cookie = (await ctx.cookies()).find(
      (c) => c.name === "cf_clearance" && matchesHost(host, c.domain),
    );
    // A cf_clearance from an unsolved page looks identical — right length, right
    // domain — and 403s on first use. Only a cleared page may produce one (§2.3).
    if (!cookie) throw new Unsolved(host, attempts);

    return {
      host,
      cookie: cookie.value,
      ua: await readUa(page, ctx),
      attempts,
      elapsedMs: Date.now() - started,
      warm,
    };
  }

  private async waitWhileChallenged(page: Page): Promise<void> {
    for (let i = 0; i < config.clearWaitSeconds; i++) {
      if (!(await challenged(page))) return;
      await sleep(1000);
    }
  }
}

/**
 * Both gates seen in the wild; bt4g's second one is served as HTTP 200.
 *
 * Body as well as title, because btdig's CAPTCHA page has a title of merely
 * `www.btdig.com` — a title-only check reported it as "not challenged" and the
 * mint then failed on the missing cookie instead, with a misleading 0 attempts.
 */
async function challenged(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => "")) ?? "";
  if (/just a moment|security check|verifying you are human/i.test(title)) return true;
  const body = await page
    .evaluate(() => document.body?.innerText?.slice(0, 400) ?? "")
    .catch(() => "");
  return /one more step|complete the security check|verify you are human/i.test(body);
}

/**
 * Which kind of gate is on screen.
 *
 * Cloudflare renders Turnstile in a `challenges.cloudflare.com` frame; Google's
 * reCAPTCHA v2 shows `recaptcha/api2/anchor` plus a `bframe` for the image
 * challenge. Detected by frame URL rather than DOM, because the widgets sit in
 * closed shadow roots that CSS cannot reach.
 */
async function detectGate(page: Page): Promise<GateKind> {
  if (!(await challenged(page))) return "none";
  const urls = page.frames().map((f) => f.url());
  if (urls.some((u) => u.includes("challenges.cloudflare.com"))) return "turnstile";
  if (urls.some((u) => u.includes("recaptcha/api2"))) return "recaptcha";
  if (urls.some((u) => u.includes("hcaptcha.com"))) return "hcaptcha";
  return "turnstile";
}

function matchesHost(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, "");
  return host === d || host.endsWith(`.${d}`);
}

/**
 * One click inside the challenge frame.
 *
 * `body` rather than `input[type=checkbox]`: Cloudflare renders the widget in
 * nested **closed** shadow roots, so CSS and role locators cannot reach the
 * checkbox and merely cost a 30s timeout on their way to failing.
 */
async function clickWidget(page: Page): Promise<void> {
  const frame: Frame | undefined = page
    .frames()
    .find((f) => f.url().includes("challenges.cloudflare.com"));
  if (!frame) return;
  await frame.locator("body").first().click({ timeout: 5000 }).catch(() => {});
}

/**
 * Read the UA, tolerating a page that is mid-navigation.
 *
 * Immediately after a solve the challenge page is being replaced, and
 * `page.evaluate` throws "Execution context was destroyed".
 */
async function readUa(page: Page, ctx: BrowserContext): Promise<string> {
  try {
    return await page.evaluate(() => navigator.userAgent);
  } catch {
    const scratch = await ctx.newPage();
    try {
      return await scratch.evaluate(() => navigator.userAgent);
    } finally {
      await scratch.close().catch(() => {});
    }
  }
}
