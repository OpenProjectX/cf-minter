import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BrowserPool, Unsolved, Unsupported } from "./browser.ts";
import { config } from "./config.ts";
import { SingleFlight } from "./singleflight.ts";

const pool = new BrowserPool();
const flight = new SingleFlight<Awaited<ReturnType<BrowserPool["mint"]>>>();
let browserReady = false;

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 8192) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const withTimeout = <T>(work: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

async function handleClearance(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: string;
  try {
    const parsed = JSON.parse(await readBody(req)) as { url?: string };
    if (!parsed.url) throw new Error("missing 'url'");
    // Validate before it reaches the browser: new URL() here turns a bad
    // request into a 400 rather than a browser navigation error.
    url = new URL(parsed.url).toString();
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }

  const host = new URL(url).host;
  try {
    // Single-flight on the HOST, not the url: two paths on one site share a
    // challenge, and solving twice would be pure waste (§4).
    const c = await flight.run(host, () => withTimeout(pool.mint(url), config.mintTimeoutMs, "mint"));
    console.log(JSON.stringify({ msg: "minted", host, attempts: c.attempts, ms: c.elapsedMs, warm: c.warm }));
    json(res, 200, {
      host: c.host,
      cookie: c.cookie,
      ua: c.ua,
      attempts: c.attempts,
      elapsedMs: c.elapsedMs,
      warm: c.warm,
      solvedAt: new Date().toISOString(),
    });
  } catch (e) {
    const err = e as Error;
    if (err instanceof Unsupported) {
      // 501, not 409: retrying will never help, so the caller should treat the
      // source as closed rather than scheduling another attempt.
      console.warn(JSON.stringify({ msg: "unsupported gate", host, kind: err.kind }));
      return json(res, 501, { error: err.message, host, kind: err.kind, retryable: false });
    }
    if (err instanceof Unsolved) {
      // 409, and deliberately no cookie: see browser.ts on why an unsolved
      // page's cf_clearance is worse than none at all.
      console.warn(JSON.stringify({ msg: "unsolved", host, error: err.message }));
      return json(res, 409, { error: err.message, host, kind: err.kind, retryable: true });
    }
    console.error(JSON.stringify({ msg: "mint failed", host, error: err.message }));
    // The browser may be wedged rather than the site being hard; drop it so the
    // next request starts from a clean process.
    await pool.close("mint failure").catch(() => {});
    json(res, 503, { error: err.message, host });
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "POST" && path === "/clearance") {
    void handleClearance(req, res);
    return;
  }
  if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
  if (req.method === "GET" && path === "/readyz") {
    // Readiness means a browser actually launched. A container whose Chromium
    // cannot start otherwise looks healthy and fails every request.
    return browserReady ? json(res, 200, { ok: true }) : json(res, 503, { ok: false });
  }
  json(res, 404, { error: `no route for ${req.method} ${path}` });
});

server.listen(config.port, () => {
  console.log(JSON.stringify({ msg: "listening", port: config.port, proxy: config.proxy ?? null }));
  pool
    .ready()
    .then(() => {
      browserReady = true;
      console.log(JSON.stringify({ msg: "browser ready" }));
    })
    .catch((e) => console.error(JSON.stringify({ msg: "browser launch failed", error: (e as Error).message })));
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void pool.close(sig).finally(() => server.close(() => process.exit(0)));
  });
}
