// `appmetrica-mcp auth`: friendly token acquisition — Yandex OAuth authorization-code flow with
// PKCE (no client secret). Default: the wizard opens the consent page in a Chrome window driven by
// playwright-core (the same profile as the web session, so the user is usually already logged in),
// the user clicks "Разрешить", Yandex redirects to oauth.yandex.ru/verification_code?code=… and the
// wizard reads the code straight from the page — nothing to copy, no redirect URI to register.
// Fallbacks: `--manual` (system browser + paste the code), `--loopback` (local callback server, for
// your own OAuth app that registers http://127.0.0.1:<port>/callback). The token lands in
// ~/.config/appmetrica-mcp/credentials.json (mode 0600); the MCP server picks it up automatically
// when APPMETRICA_OAUTH_TOKEN is not set. Yandex tokens live about a year; refresh needs the app's
// client_secret (optional APPMETRICA_OAUTH_CLIENT_SECRET), otherwise just re-run `auth`.
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";

export const OAUTH_AUTHORIZE_URL = "https://oauth.yandex.ru/authorize";
export const OAUTH_TOKEN_URL = "https://oauth.yandex.ru/token";
export const MANUAL_REDIRECT_URI = "https://oauth.yandex.ru/verification_code";
// Public client id of the appmetrica-mcp OAuth app (ClientID is not a secret). Override with
// APPMETRICA_OAUTH_CLIENT_ID to use your own app (register http://127.0.0.1:<port>/callback and
// https://oauth.yandex.ru/verification_code as its callback URIs).
export const DEFAULT_CLIENT_ID = "b8a54db2b47846f18a27ce0357b3db4a";
const DEFAULT_PORT = 8742;

export type StoredCredentials = {
  access_token: string;
  refresh_token?: string;
  expires_at?: string; // ISO
  scope?: string;
  client_id?: string;
  obtained_at: string;
};

export function credentialsPath(): string {
  return process.env.APPMETRICA_CREDENTIALS_FILE || path.join(os.homedir(), ".config", "appmetrica-mcp", "credentials.json");
}

export async function loadStoredCredentials(): Promise<StoredCredentials | undefined> {
  try {
    const raw = await fs.readFile(credentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as StoredCredentials;
    return typeof parsed.access_token === "string" && parsed.access_token ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<string> {
  const file = credentialsPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Atomic: the MCP server may read the file at any moment.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}

export function clientId(): string {
  return process.env.APPMETRICA_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(params: { clientId: string; redirectUri: string; state: string; challenge: string; scope?: string }): string {
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("state", params.state);
  u.searchParams.set("code_challenge", params.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("force_confirm", "yes");
  if (params.scope) u.searchParams.set("scope", params.scope);
  return u.toString();
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string; error?: string; error_description?: string };

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const secret = process.env.APPMETRICA_OAUTH_CLIENT_SECRET;
  if (secret) body.client_secret = secret;
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`Yandex OAuth token request failed (HTTP ${res.status}): ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  }
  return json;
}

function toStored(tok: TokenResponse, usedClientId: string): StoredCredentials {
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : undefined,
    scope: tok.scope,
    client_id: usedClientId,
    obtained_at: new Date().toISOString(),
  };
}

export async function exchangeCode(code: string, verifier: string, redirectUri: string, usedClientId: string): Promise<StoredCredentials> {
  const tok = await tokenRequest({ grant_type: "authorization_code", code, client_id: usedClientId, code_verifier: verifier, redirect_uri: redirectUri });
  return toStored(tok, usedClientId);
}

export async function refreshCredentials(creds: StoredCredentials): Promise<StoredCredentials | undefined> {
  if (!creds.refresh_token) return undefined;
  try {
    const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: creds.refresh_token, client_id: creds.client_id ?? clientId() });
    const next = toStored({ ...tok, refresh_token: tok.refresh_token ?? creds.refresh_token }, creds.client_id ?? clientId());
    await saveCredentials(next);
    return next;
  } catch {
    return undefined;
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

const DONE_HTML = `<!doctype html><meta charset="utf-8"><title>appmetrica-mcp</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 24px;color:#222">
<h1 style="font-size:22px">Готово ✅</h1><p>appmetrica-mcp получил токен AppMetrica. Эту вкладку можно закрыть и вернуться в терминал.</p></body>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const FAIL_HTML = (msg: string) => `<!doctype html><meta charset="utf-8"><title>appmetrica-mcp</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 24px;color:#222">
<h1 style="font-size:22px">Не получилось</h1><p>${escapeHtml(msg)}</p><p>Вернитесь в терминал и запустите <code>npx appmetrica-mcp auth</code> ещё раз.</p></body>`;

type WizardOptions = { manual?: boolean; loopback?: boolean; port?: number; scope?: string; log?: (line: string) => void; timeoutMs?: number };

// Loopback flow: local http server on 127.0.0.1:<port> receives ?code=&state=.
async function loopbackFlow(id: string, opts: WizardOptions): Promise<StoredCredentials> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const port = opts.port ?? (Number(process.env.APPMETRICA_OAUTH_PORT) || DEFAULT_PORT);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const url = authorizeUrl({ clientId: id, redirectUri, state, challenge, scope: opts.scope });

  return new Promise<StoredCredentials>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the browser authorization (10 minutes)."));
    }, opts.timeoutMs ?? 10 * 60 * 1000);

    let handled = false;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      // Requests that do not carry this run's state are ignored (any page can hit localhost).
      if (gotState !== state || handled) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(FAIL_HTML("Запрос не относится к текущей авторизации."));
        return;
      }
      handled = true;
      const finish = (html: string, status = 200) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html);
        clearTimeout(timeout);
        setTimeout(() => server.close(), 200);
      };
      if (err || !code) {
        finish(FAIL_HTML(`Яндекс вернул ошибку: ${err ?? "нет кода"} ${u.searchParams.get("error_description") ?? ""}`), 400);
        reject(new Error(`Authorization failed: ${err ?? "no code"} ${u.searchParams.get("error_description") ?? ""}`.trim()));
        return;
      }
      try {
        const creds = await exchangeCode(code, verifier, redirectUri, id);
        finish(DONE_HTML);
        resolve(creds);
      } catch (e) {
        finish(FAIL_HTML(e instanceof Error ? e.message : String(e)), 500);
        reject(e);
      }
    });

    server.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(new Error(e.code === "EADDRINUSE" ? `Port ${port} is busy (set APPMETRICA_OAUTH_PORT or use --manual).` : e.message));
    });

    server.listen(port, "127.0.0.1", () => {
      log(`Opening the browser for Yandex authorization…\nIf it does not open, visit:\n${url}\n`);
      openBrowser(url);
    });
  });
}

// Manual flow: Yandex shows the code on its page, the user pastes it here. `state` cannot be
// verified without a redirect; PKCE binds a code issued for this run's challenge to its verifier,
// which rules out replay of our own codes — pasting a code issued elsewhere remains the user's call.
async function manualFlow(id: string, opts: WizardOptions): Promise<StoredCredentials> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const url = authorizeUrl({ clientId: id, redirectUri: MANUAL_REDIRECT_URI, state, challenge, scope: opts.scope });
  log(`Opening the browser for Yandex authorization…\nIf it does not open, visit:\n${url}\n\nAfter you allow access Yandex shows a confirmation code.`);
  openBrowser(url);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let code = "";
  try {
    code = (await rl.question("Paste the code here: ")).trim();
  } finally {
    rl.close();
  }
  if (!code) throw new Error("No code entered");
  return exchangeCode(code, verifier, MANUAL_REDIRECT_URI, id);
}

// Default flow: a visible Chrome (playwright-core, shared profile) shows the consent page; after
// "Разрешить" Yandex lands on verification_code?code=…&state=… which we read from the URL.
async function browserFlow(id: string, opts: WizardOptions): Promise<StoredCredentials> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const url = authorizeUrl({ clientId: id, redirectUri: MANUAL_REDIRECT_URI, state, challenge, scope: opts.scope });
  const { launchContext } = await import("./web/session.js");
  log("Opening Chrome — log in to Yandex if asked and click «Разрешить»…");
  const ctx = await launchContext(false);
  try {
    // Always a fresh tab: the shared profile may restore the user's own tabs.
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Yandex appends ?code=…&state=… (or ?error=…) to the verification_code page URL. Capture the
    // URL at navigation commit, before any script on the page could rewrite it; only the URL is
    // trusted — never the page text.
    let landed: URL | undefined;
    await page.waitForURL(
      (u) => {
        if (u.hostname === "oauth.yandex.ru" && u.pathname.startsWith("/verification_code")) {
          landed = u;
          return true;
        }
        return false;
      },
      { timeout: opts.timeoutMs ?? 10 * 60 * 1000, waitUntil: "commit" }
    );
    const params = (landed as URL).searchParams;
    const err = params.get("error");
    if (err) {
      throw new Error(
        err === "access_denied"
          ? "Access was declined in the Yandex consent dialog. Run `npx appmetrica-mcp auth` again and click «Разрешить»."
          : `Yandex returned an error: ${err} ${params.get("error_description") ?? ""}`.trim()
      );
    }
    if (params.get("state") !== state) throw new Error("OAuth state mismatch — the authorization response does not belong to this run.");
    const code = params.get("code") ?? "";
    if (!code) throw new Error("Yandex did not return a confirmation code in the URL; run `npx appmetrica-mcp auth --manual`.");
    return await exchangeCode(code, verifier, MANUAL_REDIRECT_URI, id);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export async function verifyToken(token: string): Promise<{ applications: number }> {
  const res = await fetch("https://api.appmetrica.yandex.ru/management/v1/applications", { headers: { Authorization: `OAuth ${token}` } });
  if (!res.ok) throw new Error(`AppMetrica rejected the token: HTTP ${res.status}`);
  const json = (await res.json()) as { applications?: unknown[] };
  return { applications: json.applications?.length ?? 0 };
}

// The wizard. Returns the saved credentials; throws with a readable message on failure.
export async function runAuthWizard(opts: WizardOptions = {}): Promise<{ credentials: StoredCredentials; file: string; applications: number }> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const id = clientId();
  if (!id) {
    throw new Error(
      [
        "No OAuth client id configured.",
        "Create a Yandex OAuth app once at https://oauth.yandex.ru/client/new (platform «Веб-сервисы», Redirect URI",
        `${MANUAL_REDIRECT_URI}; add http://127.0.0.1:${opts.port ?? DEFAULT_PORT}/callback only if you want --loopback; access «AppMetrica» read/write),`,
        "then run: APPMETRICA_OAUTH_CLIENT_ID=<ClientID> npx appmetrica-mcp auth",
      ].join("\n")
    );
  }
  let creds: StoredCredentials;
  if (opts.manual) {
    creds = await manualFlow(id, opts);
  } else if (opts.loopback) {
    creds = await loopbackFlow(id, opts);
  } else {
    try {
      creds = await browserFlow(id, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Any failure to start/drive Chrome → fall back to the manual flow when a human is present.
      const launchProblem = /Cannot launch Chrome|already open|Executable doesn't exist|Browser was not found|browserType\.launch|Failed to launch/i.test(msg);
      if (launchProblem && process.stdin.isTTY) {
        log(`${msg}\nFalling back to the manual code flow.`);
        creds = await manualFlow(id, opts);
      } else {
        throw new Error(`${msg}\nTip: \`npx appmetrica-mcp auth --manual\` opens your default browser and lets you paste the code instead.`);
      }
    }
  }
  const { applications } = await verifyToken(creds.access_token);
  const file = await saveCredentials(creds);
  return { credentials: creds, file, applications };
}

// Token resolution for the MCP server: env wins; otherwise the stored credentials (refreshed
// when expired and a refresh token is available).
export async function resolveToken(): Promise<string | undefined> {
  const env = process.env.APPMETRICA_OAUTH_TOKEN;
  if (env) return env;
  let creds = await loadStoredCredentials();
  if (!creds) return undefined;
  if (creds.expires_at && Date.parse(creds.expires_at) < Date.now() + 60_000) {
    creds = (await refreshCredentials(creds)) ?? creds;
  }
  return creds.access_token;
}

export const NO_TOKEN_MESSAGE =
  "No AppMetrica OAuth token: run `npx appmetrica-mcp auth` once (opens the browser, you click «Разрешить»), or set APPMETRICA_OAUTH_TOKEN.";
