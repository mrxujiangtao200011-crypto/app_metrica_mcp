#!/usr/bin/env node
// Regenerates src/catalog.generated.ts from the official AppMetrica docs.
// Sources: https://appmetrica.yandex.ru/docs/ru/llms.txt → Reporting API metric/attribute
// pages (mobile-api/stat/metrics/*, mobile-api/stat/attributes/*) and Logs API table
// references (mobile-api/logs/ref/*). Run: node scripts/update-catalog.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LLMS_URL = "https://appmetrica.yandex.ru/docs/ru/llms.txt";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/catalog.generated.ts");
const CONCURRENCY = 6;

async function fetchText(url, attempt = 1) {
  const res = await fetch(url, { headers: { "User-Agent": "appmetrica-mcp catalog generator" } });
  const text = await res.text();
  // The docs host answers "limited" (HTTP 429) when hammered — back off and retry.
  if (res.status === 429 || text.trim() === "limited") {
    if (attempt > 5) throw new Error(`rate limited: ${url}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    return fetchText(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return text;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// `ym:r2:adRevenue[\<currency\>](https://...param.md)` → `ym:r2:adRevenue<currency>`
const cleanKey = (raw) =>
  raw
    .replace(/`/g, "")
    .replace(/\[\\?<([a-z_]+)\\?>\]\([^)]*\)/g, "<$1>")
    .replace(/\\</g, "<")
    .replace(/\\>/g, ">")
    .trim();

const cells = (line) =>
  line
    .replace(/^\|\|/, "")
    .replace(/\|\|$/, "")
    .split("|")
    .map((c) => c.trim());

const llms = await fetchText(LLMS_URL);
const urls = [...new Set([...llms.matchAll(/https:\/\/appmetrica\.yandex\.ru\/docs\/ru\/mobile-api\/(?:stat\/(?:metrics|attributes)\/[^)\s]+|logs\/ref\/[^)\s]+)\.md/g)].map((m) => m[0]))];
console.error(`fetching ${urls.length} doc pages…`);
const pages = await mapLimit(urls, CONCURRENCY, async (url) => ({ url, text: await fetchText(url) }));

const metrics = [];
const dimsByKey = new Map();
const logsTables = {};
const seen = new Set();

for (const { url, text } of pages) {
  const title = (text.match(/^# (.+)$/m) || [])[1]?.trim() || "";
  if (url.includes("/logs/ref/")) {
    if (url.endsWith("/index.md")) continue;
    const table = (text.match(/\/logs\/v1\/export\/([a-z_0-9]+)\./) || [])[1];
    if (!table) continue;
    const fields = [...new Set([...text.matchAll(/^\|\| `([a-z_0-9]+)`/gm)].map((m) => m[1]))];
    logsTables[table] = fields;
    continue;
  }
  const kind = url.includes("/metrics/") ? "metric" : "dimension";
  for (const line of text.split("\n")) {
    if (!line.startsWith("||`ym:")) continue;
    const c = cells(line);
    const key = cleanKey(c[0]);
    if (seen.has(kind + key)) continue;
    seen.add(kind + key);
    if (kind === "metric") {
      metrics.push({ key, name: c[1] || "", description: c[2] || "", type: (c[3] || "").replace(/`/g, ""), page: title });
    } else {
      dimsByKey.set(key, { key, name: c[1] || "", description: c[3] || "", page: title });
    }
  }
}

// Dimensions repeat across namespaces (ym:u:date, ym:s:date, …) — store each suffix once
// with the list of namespaces it is documented for.
const dims = new Map();
for (const d of dimsByKey.values()) {
  const [, nsPart, ...rest] = d.key.split(":");
  const ns = `ym:${nsPart}:`;
  const suffix = rest.join(":");
  if (!dims.has(suffix)) dims.set(suffix, { suffix, name: d.name, description: d.description, page: d.page, namespaces: [] });
  const entry = dims.get(suffix);
  if (!entry.namespaces.includes(ns)) entry.namespaces.push(ns);
}

// Request parameters documented alongside the table fields — not exportable columns.
const LOGS_REQUEST_PARAMS = new Set(["application_id", "date_since", "date_until", "fields", "date_dimension", "limit", "use_utf8_bom", "skip_unavailable_shards", "version", "update_timestamp"]);
for (const [t, f] of Object.entries(logsTables)) logsTables[t] = f.filter((x) => !LOGS_REQUEST_PARAMS.has(x));

const body = `// GENERATED FILE — do not edit by hand. Regenerate with: node scripts/update-catalog.mjs
// Source: official AppMetrica docs (${LLMS_URL}), generated ${new Date().toISOString().slice(0, 10)}.

export type CatalogMetric = { key: string; name: string; description: string; type: string; page: string };
export type CatalogDimension = { suffix: string; name: string; description: string; page: string; namespaces: string[] };

export const METRICS: CatalogMetric[] = ${JSON.stringify(metrics)};

export const DIMENSIONS: CatalogDimension[] = ${JSON.stringify([...dims.values()])};

export const LOGS_TABLES: Record<string, string[]> = ${JSON.stringify(logsTables)};
`;
fs.writeFileSync(OUT, body);
console.error(`wrote ${OUT}: ${metrics.length} metrics, ${dims.size} dimensions, ${Object.keys(logsTables).length} logs tables`);
