// Experimental: AppMetrica web session for the parts of the product that have no public API
// (workspaces / dashboards / widgets). The web UI talks to an internal GraphQL endpoint
// (`POST https://appmetrica.yandex.ru/api`) that needs a Yandex cookie session plus a CSRF token
// embedded in the page — an OAuth token is rejected. We therefore drive a real Chrome
// (playwright-core, system Chrome channel) with a persistent profile: the user logs in once
// (`appmetrica-mcp login`), after that every tool call reuses the saved session headlessly.
// Yandex refreshes the session cookies on every visit and the server renews the CSRF token via
// the `renewed-csrf-token` response header, so re-logins are only needed if Yandex itself
// invalidates the session.
//
// A Chrome profile can be open in one Chrome at a time, so the headless context is closed after
// APPMETRICA_BROWSER_IDLE_MS of inactivity (default 2 min) and whenever the session turns out to
// be logged out — this is what lets `appmetrica-mcp login` run while the MCP server is alive.
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

export const APPMETRICA_ORIGIN = "https://appmetrica.yandex.ru";
const LOGIN_URL = `https://passport.yandex.ru/auth?retpath=${encodeURIComponent(APPMETRICA_ORIGIN + "/")}`;
const IDLE_MS = Math.min(Number(process.env.APPMETRICA_BROWSER_IDLE_MS) > 0 ? Number(process.env.APPMETRICA_BROWSER_IDLE_MS) : 120_000, 2_147_000_000);
const REQUEST_TIMEOUT_MS = 60_000;

export function profileDir(): string {
  return process.env.APPMETRICA_BROWSER_PROFILE ?? path.join(os.homedir(), ".config", "appmetrica-mcp", "chrome-profile");
}

export class NotLoggedInError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "AppMetrica web session is not logged in. Run `npx appmetrica-mcp login` (opens Chrome; log in to Yandex once), then retry."
    );
    this.name = "NotLoggedInError";
  }
}

export async function launchContext(headless: boolean): Promise<BrowserContext> {
  const executablePath = process.env.APPMETRICA_BROWSER_PATH;
  const channel = executablePath ? undefined : (process.env.APPMETRICA_BROWSER_CHANNEL ?? "chrome");
  try {
    return await chromium.launchPersistentContext(profileDir(), {
      headless,
      channel,
      executablePath,
      viewport: { width: 1366, height: 900 },
      locale: "ru-RU",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    if (/in use|existing browser session|SingletonLock|ProcessSingleton/i.test(msg)) {
      throw new Error(
        `The Chrome profile ${profileDir()} is already open in another Chrome (a running appmetrica-mcp server or another \`login\`). Wait for the server to go idle (${Math.round(IDLE_MS / 1000)} s) or stop it, then retry.`
      );
    }
    throw new Error(
      `Cannot launch Chrome for the AppMetrica web session: ${msg}. Install Google Chrome, or set APPMETRICA_BROWSER_PATH (executable) / APPMETRICA_BROWSER_CHANNEL (chrome | chromium | msedge).`
    );
  }
}

type Probe = { href: string; csrf: string | null; hasBootstrap: boolean };

// Runs inside the page: the CSRF token lives in the inline `window.__bootstrapData` blob.
function probeInPage(): Probe {
  const w = window as unknown as { __bootstrapData?: unknown };
  const find = (o: unknown, depth = 0): string | null => {
    if (!o || typeof o !== "object" || depth > 8) return null;
    const rec = o as Record<string, unknown>;
    if (typeof rec.csrfToken === "string") return rec.csrfToken;
    for (const v of Object.values(rec)) {
      const r = find(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return { href: location.href, csrf: find(w.__bootstrapData), hasBootstrap: Boolean(w.__bootstrapData) };
}

function isLoggedInUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.hostname === "appmetrica.yandex.ru" && !u.pathname.startsWith("/about");
  } catch {
    return false;
  }
}

type GqlRaw = { status: number; renewed: string | null; text: string };

export class WebSession {
  private ctx?: BrowserContext;
  private page?: Page;
  private csrf?: string;
  private ensuring?: Promise<void>;
  // All requests share one Page, so they run one at a time (a CSRF reload must never destroy
  // another call's execution context).
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly headless = true) {}

  private async ensure(): Promise<void> {
    if (!this.ensuring) {
      this.ensuring = this.doEnsure().finally(() => {
        this.ensuring = undefined;
      });
    }
    return this.ensuring;
  }

  private async doEnsure(): Promise<void> {
    if (!this.ctx) {
      const ctx = await launchContext(this.headless);
      this.ctx = ctx;
      this.page = ctx.pages()[0] ?? (await ctx.newPage());
      // Chrome died or was closed from outside: forget it so the next call relaunches.
      ctx.on("close", () => {
        if (this.ctx === ctx) {
          this.ctx = undefined;
          this.page = undefined;
          this.csrf = undefined;
        }
      });
    }
    const page = this.page as Page;
    let probe = await this.probe(page);
    if (!probe) {
      await page.goto(`${APPMETRICA_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page
        .waitForFunction(
          () => {
            const w = window as unknown as { __bootstrapData?: unknown };
            return Boolean(w.__bootstrapData) || /passport\./.test(location.hostname) || location.pathname.startsWith("/about");
          },
          null,
          { timeout: 30000 }
        )
        .catch(() => undefined);
      probe = await this.probe(page);
      if (!probe) {
        // Release the profile so that `appmetrica-mcp login` can open it.
        await this.close();
        throw new NotLoggedInError();
      }
    }
    // Keep a token renewed by the server (renewed-csrf-token) over the static one from the page.
    if (!this.csrf) this.csrf = probe;
  }

  // Returns the CSRF token when the page is a logged-in AppMetrica page, else null.
  private async probe(page: Page): Promise<string | null> {
    try {
      const p = await page.evaluate(probeInPage);
      return isLoggedInUrl(p.href) && p.csrf ? p.csrf : null;
    } catch {
      return null;
    }
  }

  private async rawRequest(query: string, variables: Record<string, unknown>): Promise<GqlRaw> {
    const page = this.page as Page;
    return page.evaluate(
      async ({ query, variables, csrf, timeoutMs }) => {
        const r = await fetch("/api", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "x-csrf-token": csrf, "x-lang": "ru" },
          body: JSON.stringify({ query, variables }),
          // A hung request would otherwise block the whole (serialised) queue forever.
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: r.status, renewed: r.headers.get("renewed-csrf-token"), text: await r.text() };
      },
      { query, variables, csrf: this.csrf as string, timeoutMs: REQUEST_TIMEOUT_MS }
    );
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  // Arms the idle timer only when nothing is running or queued; the close itself goes through the
  // queue so it can never interrupt a request or race a relaunch.
  private scheduleIdleClose(): void {
    this.touch();
    if (!this.ctx || this.pending > 0) return;
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      this.queue = this.queue.then(
        () => (this.pending === 0 ? this.close() : undefined),
        () => (this.pending === 0 ? this.close() : undefined)
      );
    }, IDLE_MS);
    timer.unref?.();
    this.idleTimer = timer;
  }

  // Runs `fn` exclusively (one request at a time) and re-arms the idle timer when the queue drains.
  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    this.touch();
    this.pending++;
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    try {
      return await run;
    } finally {
      this.pending--;
      this.scheduleIdleClose();
    }
  }

  // Executes one generated GraphQL document of the web client and unwraps `{ data: { <op>: { data, error } } }`.
  gql<T = unknown>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.serialized(() => this.gqlUnlocked<T>(operationName, query, variables));
  }

  private async gqlUnlocked<T>(operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
    await this.ensure();
    let res = await this.rawRequest(query, variables);
    if (res.renewed) this.csrf = res.renewed;
    let body = parseJson(res.text);

    if (body?.reason?.kind === "csrf_error") {
      // Token rotated server-side: reload the page to pick up the fresh one and retry once.
      const page = this.page as Page;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
      const csrf = await this.probe(page);
      if (!csrf) {
        await this.close();
        throw new NotLoggedInError();
      }
      this.csrf = csrf;
      res = await this.rawRequest(query, variables);
      if (res.renewed) this.csrf = res.renewed;
      body = parseJson(res.text);
    }

    if (res.status === 429) throw new Error("AppMetrica web API answered 429 ('limited'): too many requests, wait a minute and retry.");
    if (res.status === 401 || (res.status === 403 && body?.reason?.kind === "csrf_error")) {
      await this.close();
      throw new NotLoggedInError();
    }
    if (!body) throw new Error(`AppMetrica web API: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    if (body.error) throw new Error(`AppMetrica web API error: ${JSON.stringify(body.error).slice(0, 600)}`);
    if (Array.isArray(body.errors)) throw new Error(`AppMetrica web API error: ${JSON.stringify(body.errors).slice(0, 600)}`);

    const op = body.data?.[operationName];
    if (!op || typeof op !== "object") throw new Error(`AppMetrica web API: no "${operationName}" in response: ${res.text.slice(0, 300)}`);
    if (op.error) throw new Error(`${operationName}: ${JSON.stringify(op.error).slice(0, 600)}`);
    return op.data as T;
  }

  // `login` is the Yandex account name (the `yandex_login` cookie) — the only cookie value exposed.
  status(): Promise<{ logged_in: boolean; login?: string; profile_dir: string; hint?: string }> {
    return this.serialized(async () => {
      try {
        await this.ensure();
        const cookies = await (this.ctx as BrowserContext).cookies(APPMETRICA_ORIGIN);
        const login = cookies.find((c) => c.name === "yandex_login")?.value;
        return { logged_in: true, login, profile_dir: profileDir() };
      } catch (e) {
        if (e instanceof NotLoggedInError) return { logged_in: false, profile_dir: profileDir(), hint: e.message };
        throw e;
      }
    });
  }

  async close(): Promise<void> {
    this.touch();
    const ctx = this.ctx;
    this.ctx = undefined;
    this.page = undefined;
    this.csrf = undefined;
    await ctx?.close().catch(() => undefined);
  }
}

type AnyJson = { [k: string]: any } | null;
function parseJson(text: string): AnyJson {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as AnyJson) : null;
  } catch {
    return null;
  }
}

// `appmetrica-mcp login`: opens a visible Chrome on the Yandex login page and waits until the user
// is back on a logged-in AppMetrica page. Nothing is typed by us — the user enters credentials.
export async function loginInteractive(timeoutMs = 10 * 60 * 1000): Promise<{ login?: string }> {
  const ctx = await launchContext(false);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${APPMETRICA_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
    const already = await page.evaluate(probeInPage).catch(() => null);
    if (!(already && isLoggedInUrl(already.href) && already.csrf)) {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __bootstrapData?: unknown };
          return location.hostname === "appmetrica.yandex.ru" && !location.pathname.startsWith("/about") && Boolean(w.__bootstrapData);
        },
        null,
        { timeout: timeoutMs, polling: 1000 }
      );
    }
    const cookies = await ctx.cookies(APPMETRICA_ORIGIN);
    return { login: cookies.find((c) => c.name === "yandex_login")?.value };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
