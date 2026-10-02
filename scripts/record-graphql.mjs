#!/usr/bin/env node
// Dev tool: records the AppMetrica web GraphQL operations (generated query documents, variables,
// responses) while the web UI runs in the logged-in Chrome profile (see `appmetrica-mcp login`).
// Usage: node scripts/record-graphql.mjs [--app <appId>] [--out <file.json>] [--headless]
//   Opens /dashboard for the app, then records everything you do in the window.
//   Press Enter in this terminal to stop and save; use the file to update src/web/operations.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchContext, APPMETRICA_ORIGIN } from "../dist/web/session.js";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const appId = opt("--app", "");
const headless = args.includes("--headless");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = opt("--out", path.join(root, ".claude", "recordings", `graphql-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));

const entries = [];
const pending = new Map();
const opNames = (q) => [...String(q).matchAll(/\b(query|mutation)\s+([A-Za-z0-9_]+)/g)].map((m) => m[2]);

function attach(page) {
  page.on("request", (req) => {
    if (req.method() !== "POST" || req.url() !== `${APPMETRICA_ORIGIN}/api`) return;
    try {
      const j = JSON.parse(req.postData() ?? "");
      pending.set(req, { t: Date.now(), ops: opNames(j.query), query: j.query, variables: j.variables ?? {}, url: page.url() });
    } catch { /* not JSON */ }
  });
  page.on("response", async (res) => {
    const e = pending.get(res.request());
    if (!e) return;
    pending.delete(res.request());
    e.status = res.status();
    try { e.response = (await res.text()).slice(0, 30000); } catch { e.response = null; }
    entries.push(e);
    console.error(`  ${e.ops.join("|") || "?"}  ${e.status}  vars=${JSON.stringify(e.variables).slice(0, 120)}`);
  });
}

const ctx = await launchContext(headless);
ctx.on("page", attach);
const page = ctx.pages()[0] ?? (await ctx.newPage());
attach(page);
await page.goto(`${APPMETRICA_ORIGIN}/dashboard${appId ? `?appId=${appId}` : ""}`, { waitUntil: "domcontentloaded" });
console.error(`Recording GraphQL traffic of ${APPMETRICA_ORIGIN} → ${out}\nUse the web UI in the Chrome window (open workspaces, create/rename/delete a test workspace, add widgets…).\nPress Enter here to stop and save.`);
await new Promise((resolve) => { process.stdin.resume(); process.stdin.once("data", resolve); });
await ctx.close().catch(() => undefined);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ recorded_at: new Date().toISOString(), entries }, null, 1));
const summary = {};
for (const e of entries) summary[e.ops.join("|") || "?"] = (summary[e.ops.join("|") || "?"] ?? 0) + 1;
console.error(`Saved ${entries.length} requests:`, JSON.stringify(summary));
