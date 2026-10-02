import { z } from "zod";
import type { AppMetricaClient } from "../client.js";
import type { ServerAdapter } from "../server.js";
import { DIMENSIONS, METRICS } from "../catalog.generated.js";
import { combineFilters, resolveSegmentExpression } from "../segments.js";
import { namespaceOf, ok, err } from "../util.js";

// Namespace descriptions for the list_metrics overview. Counts come from the generated catalogue.
const NAMESPACES: Array<[prefix: string, description: string]> = [
  ["ym:u:", "users"],
  ["ym:s:", "sessions"],
  ["ym:ge:", "generic events"],
  ["ym:ce:", "client events (ym:ce2 is the join variant)"],
  ["ym:ce2:", "client events, join variant (event params)"],
  ["ym:cr:", "crashes (ym:cr2 is the newer variant)"],
  ["ym:cr2:", "crashes, v2 (crash-free percentages)"],
  ["ym:er:", "errors (ym:er2 is the newer variant)"],
  ["ym:er2:", "errors, v2"],
  ["ym:anr:", "ANRs (ym:anr2 is the newer variant)"],
  ["ym:anr2:", "ANRs, v2"],
  ["ym:i:", "installs"],
  ["ym:ts:", "traffic sources (tracker clicks, impressions, installs)"],
  ["ym:o:", "deeplink opens"],
  ["ym:ae:", "conversions (attributed events)"],
  ["ym:ae2:", "conversions (attributed events), v2"],
  ["ym:pc:", "push campaigns"],
  ["ym:r:", "revenue"],
  ["ym:r2:", "revenue, v2 (metrics need the <currency> placeholder + currency param)"],
  ["ym:ec:", "e-commerce"],
  ["ym:ec2:", "e-commerce, v2"],
  ["ym:p:", "profiles"],
  ["ym:d:", "devices"],
  ["ym:uf:", "funnels, multi-session (step metrics only: ym:uf:devicesInStepN, see get_funnel_report)"],
  ["ym:sf:", "funnels, single-session (step metrics only: ym:sf:devicesInStepN, see get_funnel_report)"],
];

// Confirmed live (HTTP 200) on 2026-10-03.
const VERIFIED_LIVE = [
  "ym:u:users", "ym:u:activeUsers", "ym:u:newUsers", "ym:u:dormantUsers", "ym:u:resurrectedUsers",
  "ym:s:sessions", "ym:s:sessionsPerUser", "ym:s:totalSessionDurationPerUser", "ym:s:totalSessionDuration", "ym:s:avgSessionDuration",
  "ym:cr:crashes", "ym:cr:crashDevices", "ym:cr:crashSessions",
  "ym:cr2:crashes", "ym:cr2:crashDevices", "ym:cr2:crashSessions", "ym:cr2:crashesFreeSessionsPercentage", "ym:cr2:crashesFreeDevicesPercentage", "ym:cr2:crashesDevicesPercentage",
  "ym:er2:errors", "ym:er2:errorDevices", "ym:er2:errorsFreeSessionsPercentage",
  "ym:anr2:anrEvents", "ym:anr2:anrDevices", "ym:anr2:anrFreeSessionsPercentage",
  "ym:ge:users", "ym:ge:devices", "ym:ge:sessions", "ym:ge:totalEvents",
  "ym:ce:allEvents", "ym:ce:users", "ym:ce:devices", "ym:ce:sessions",
  "ym:ce2:allEvents", "ym:ce2:devicesWithEvent", "ym:ce2:eventsPerDevice", "ym:ce2:devicesPercent",
  "ym:i:installEvents", "ym:i:installDevices", "ym:i:advInstallDevices",
  "ym:ts:advInstallDevices", "ym:ts:userClicks", "ym:ts:impressions", "ym:ts:clickToInstallConversion",
  "ym:ae2:attributedEvents", "ym:ae2:attributedDevices", "ym:ae2:attributedDevicesPercentage",
  "ym:pc:sentDevices", "ym:pc:receivedDevices", "ym:pc:openedDevices", "ym:pc:eventsConversion",
  "ym:r2:revenue<currency>", "ym:r2:revenuePerDevice<currency>", "ym:r2:purchases",
  "ym:r2:inappRevenue<currency>", "ym:r2:inappRevenueDevices", "ym:r2:inappAverageOrderValue<currency>",
  "ym:r2:adRevenue<currency>", "ym:r2:adRevenueDevices", "ym:r2:adRevenuePerDevice<currency>", "ym:r2:adRevenueECPM<currency>", "ym:r2:adRevenueDevicesPercentage",
  "ym:d:devices", "ym:p:devices",
];

// Keys that do NOT exist (HTTP 4002).
const TRAPS = [
  "ym:u:sessions",
  "ym:u:crashes",
  "ym:u:revenue",
  "ym:r2:revenue (without <currency>)",
  "ym:uf:usersInStepN (use ym:uf:devicesInStepN)",
];

const RECIPES = {
  revenue: {
    problem: "Revenue / purchases / ARPU.",
    solution:
      "get_report with ym:r2:revenue<currency>, ym:r2:revenuePerDevice<currency>, ym:r2:purchases, ym:r2:inappRevenue<currency>, ym:r2:adRevenue<currency>, ... and the currency param (RUB|USD|EUR|YND). Keep the literal '<currency>' in the metric key.",
  },
  crash_rate: {
    problem: "Crash rate.",
    solution:
      "ym:cr2:crashesFreeSessionsPercentage (or ym:cr2:crashesFreeDevicesPercentage) via get_report; get_dashboard preset 'crashes' bundles them.",
  },
  funnels: {
    problem: "Funnel / step conversion.",
    solution:
      "get_funnel_report: pass funnel_id of a saved funnel (list_funnels) or ad-hoc steps (event names from list_events). Step metrics are ym:uf:devicesInStepN.",
  },
  retention: {
    problem: "Retention (D1/D7/D30).",
    solution:
      "Not available in the Reporting API. Use export_logs with table sessions_starts / installations and compute cohorts client-side (heavy for D30) or the AppMetrica web UI.",
  },
  segments: {
    problem: "Restrict a report to a saved web-UI segment.",
    solution: "list_segments, then pass segment_id to get_report / get_report_bytime / get_funnel_report / get_dashboard.",
  },
  push_open_rate: {
    problem: "Push open rate.",
    solution: "ym:pc:openedDevices / ym:pc:sentDevices via get_report (device-level), or get_dashboard preset 'push'.",
  },
};

const NOTES = [
  "One namespace prefix per request: get_report_bytime fails with error 4011 when mixing e.g. ym:u: and ym:s:; get_report is lenient but keep one prefix anyway. A different prefix is fine inside filters.",
  "Metrics containing '<currency>' are sent as-is plus the currency param. Other placeholders (e.g. <param_value_path>) are documented in the AppMetrica docs.",
  "Unknown keys fail with HTTP 4002 (metric) or 4001 (dimension). Catalogue source: scripts/update-catalog.mjs.",
];

function normalizeNamespace(ns: string): string {
  let x = ns.trim();
  if (x.startsWith("ym:")) x = x.slice(3);
  if (x.endsWith(":")) x = x.slice(0, -1);
  return `ym:${x}:`;
}

async function reportParams(
  client: AppMetricaClient,
  a: {
    app_id: number;
    metrics: string[];
    dimensions?: string[];
    date_from: string;
    date_to: string;
    filters?: string;
    segment_id?: number;
    currency?: string;
    accuracy?: string;
    limit?: number;
  }
): Promise<Record<string, string | number | undefined>> {
  const segmentExpr =
    a.segment_id !== undefined ? await resolveSegmentExpression(client, a.app_id, a.segment_id) : undefined;
  return {
    id: a.app_id,
    metrics: a.metrics.join(","),
    dimensions: a.dimensions && a.dimensions.length > 0 ? a.dimensions.join(",") : undefined,
    date1: a.date_from,
    date2: a.date_to,
    filters: combineFilters(segmentExpr, a.filters),
    currency: a.currency,
    accuracy: a.accuracy,
    limit: a.limit,
  };
}

export function registerReportingTools(server: ServerAdapter, client: AppMetricaClient): void {
  server.tool(
    "get_report",
    `Retrieve aggregated statistics from AppMetrica (/stat/v1/data).
Call list_metrics first (overview) or list_metrics with search/namespace to find exact keys.
Quick reference: ym:u:* users · ym:s:* sessions · ym:ce:* client events · ym:cr2:* crashes · ym:i:* installs · ym:r2:* revenue · ym:pc:* push.
Revenue metrics carry a literal <currency> placeholder (e.g. ym:r2:revenue<currency>) — pass currency (RUB|USD|EUR|YND) alongside.
Funnel step metrics (ym:uf:*) need a funnel pattern — use get_funnel_report instead.
Keep one namespace prefix per call. Known non-existent keys (4002): ym:u:sessions, ym:u:crashes, ym:u:revenue, ym:r2:revenue without <currency>.
Filters use the segmentation syntax, e.g. "ym:u:operatingSystemInfo=='iOS'"; segment_id (from list_segments) ANDs a saved segment expression into filters.
A sporadic 400 "Запрос слишком сложный" means: retry, narrow the date range, or pass accuracy (e.g. 0.1, sampled result).`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      metrics: z.array(z.string()).describe("Metric keys to retrieve, e.g. ['ym:u:users', 'ym:s:sessions']"),
      dimensions: z.array(z.string()).optional().describe("Dimension keys for breakdown, e.g. ['ym:u:date', 'ym:u:appVersion']"),
      date_from: z.string().describe("Start date in YYYY-MM-DD format"),
      date_to: z.string().describe("End date in YYYY-MM-DD format"),
      limit: z.number().optional().default(100).describe("Maximum number of rows to return"),
      offset: z.number().optional().describe("Row offset for paging"),
      filters: z.string().optional().describe("Segmentation filter expression, e.g. \"ym:u:operatingSystemInfo=='iOS'\""),
      sort: z.string().optional().describe("Sort by a metric/dimension: '-ym:u:users' descending, 'ym:u:users' ascending"),
      segment_id: z.number().optional().describe("Saved segment ID (see list_segments); its expression is ANDed with filters"),
      currency: z.enum(["RUB", "USD", "EUR", "YND"]).optional().describe("Currency for <currency>-parametrised revenue metrics"),
      accuracy: z.string().optional().describe("Sampling accuracy, e.g. '0.1' (faster, sampled result)"),
      include_undefined: z.boolean().optional().describe("Include rows with undefined dimension values"),
      lang: z.enum(["ru", "en"]).optional().describe("Language of dimension names"),
    },
    async (args) => {
      try {
        const a = args as {
          app_id: number;
          metrics: string[];
          dimensions?: string[];
          date_from: string;
          date_to: string;
          limit?: number;
          offset?: number;
          filters?: string;
          sort?: string;
          segment_id?: number;
          currency?: string;
          accuracy?: string;
          include_undefined?: boolean;
          lang?: string;
        };

        const params = await reportParams(client, { ...a, limit: a.limit ?? 100 });
        params.offset = a.offset;
        params.sort = a.sort;
        params.lang = a.lang;
        if (a.include_undefined) params.include_undefined = "true";

        const data = await client.get<unknown>("/stat/v1/data", params);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_report_bytime",
    `Retrieve AppMetrica statistics as a time series (/stat/v1/data/bytime): the same metrics/dimensions as get_report, split by day/week/month/hour or a single interval (group=all).
Response: data[i].metrics[m][t] arrays aligned with time_intervals, plus totals.
IMPORTANT: use ONE namespace prefix per call (all metrics and dimensions ym:u:*, or all ym:s:*, ...). Mixing prefixes fails with error 4011 — issue one call per namespace.
Revenue metrics with a <currency> placeholder need the currency param. segment_id (from list_segments) is ANDed with filters.
A sporadic 400 "Запрос слишком сложный" means: retry, narrow the date range, or pass accuracy (e.g. 0.1).`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      metrics: z.array(z.string()).describe("Metric keys (single namespace), e.g. ['ym:u:users', 'ym:u:newUsers']"),
      dimensions: z.array(z.string()).optional().describe("Dimension keys (same namespace as metrics)"),
      date_from: z.string().describe("Start date in YYYY-MM-DD format"),
      date_to: z.string().describe("End date in YYYY-MM-DD format"),
      group: z.enum(["day", "week", "month", "hour", "all"]).optional().default("day").describe("Time bucket size (default day)"),
      filters: z.string().optional().describe("Segmentation filter expression"),
      segment_id: z.number().optional().describe("Saved segment ID (see list_segments); its expression is ANDed with filters"),
      limit: z.number().optional().describe("Maximum number of dimension rows"),
      currency: z.enum(["RUB", "USD", "EUR", "YND"]).optional().describe("Currency for <currency>-parametrised revenue metrics"),
      accuracy: z.string().optional().describe("Sampling accuracy, e.g. '0.1'"),
    },
    async (args) => {
      try {
        const a = args as {
          app_id: number;
          metrics: string[];
          dimensions?: string[];
          date_from: string;
          date_to: string;
          group?: string;
          filters?: string;
          segment_id?: number;
          limit?: number;
          currency?: string;
          accuracy?: string;
        };

        const params = await reportParams(client, a);
        params.group = a.group ?? "day";

        const data = await client.get<unknown>("/stat/v1/data/bytime", params);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_drilldown",
    "Retrieve drilldown statistics for a specific parent dimension value in AppMetrica. Useful for hierarchical data exploration.",
    {
      app_id: z.number().describe("AppMetrica application ID"),
      parent_id: z.string().describe("Parent dimension value ID for drilldown"),
      metrics: z.array(z.string()).describe("Metric keys to retrieve"),
      dimensions: z.array(z.string()).optional().describe("Dimension keys for the drilldown levels"),
      date_from: z.string().describe("Start date in YYYY-MM-DD format"),
      date_to: z.string().describe("End date in YYYY-MM-DD format"),
      filters: z.string().optional().describe("Segmentation filter expression"),
      limit: z.number().optional().describe("Maximum number of rows to return"),
    },
    async (args) => {
      try {
        const { app_id, parent_id, metrics, dimensions, date_from, date_to, filters, limit } = args as {
          app_id: number;
          parent_id: string;
          metrics: string[];
          dimensions?: string[];
          date_from: string;
          date_to: string;
          filters?: string;
          limit?: number;
        };

        const params: Record<string, string | number | undefined> = {
          id: app_id,
          parent_id,
          metrics: metrics.join(","),
          dimensions: dimensions && dimensions.length > 0 ? dimensions.join(",") : undefined,
          date1: date_from,
          date2: date_to,
          filters,
          limit,
        };

        const data = await client.get<unknown>("/stat/v1/data/drilldown", params);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_metrics",
    `Catalogue of AppMetrica Reporting API metric and dimension keys, built from the official docs (scripts/update-catalog.mjs): ${METRICS.length} metrics, ${DIMENSIONS.length} dimensions.
Without search/namespace returns a compact overview: namespaces table, keys verified live, known non-existent keys (traps) and recipes for analytics that need a special tool.
With search (case-insensitive substring over key/name/description) and/or namespace (e.g. 'ym:u:' or 'u') returns matching entries, truncated to limit with a total count.
Metrics are listed with full keys (some contain placeholders like <currency>); dimensions are listed by suffix plus the namespaces where they exist (key = namespace + suffix, e.g. ym:u: + appVersion).`,
    {
      search: z.string().optional().describe("Case-insensitive substring over key/name/description"),
      namespace: z.string().optional().describe("Namespace filter, e.g. 'ym:u:' or 'u'"),
      kind: z.enum(["metrics", "dimensions", "all"]).optional().default("all").describe("What to list (default all)"),
      limit: z.number().optional().default(50).describe("Max entries per kind (default 50)"),
    },
    async (args) => {
      try {
        const { search, namespace, kind, limit } = args as {
          search?: string;
          namespace?: string;
          kind?: "metrics" | "dimensions" | "all";
          limit?: number;
        };

        if (!search && !namespace) {
          const metricCount = new Map<string, number>();
          for (const m of METRICS) {
            const prefix = `${namespaceOf(m.key)}:`;
            metricCount.set(prefix, (metricCount.get(prefix) ?? 0) + 1);
          }
          const dimensionCount = new Map<string, number>();
          for (const d of DIMENSIONS) {
            for (const prefix of d.namespaces) dimensionCount.set(prefix, (dimensionCount.get(prefix) ?? 0) + 1);
          }
          return ok({
            namespaces: NAMESPACES.map(([prefix, description]) => ({
              prefix,
              description,
              metrics: metricCount.get(prefix) ?? 0,
              dimensions: dimensionCount.get(prefix) ?? 0,
            })),
            totals: { metrics: METRICS.length, dimensions: DIMENSIONS.length },
            verified_live: VERIFIED_LIVE,
            traps: TRAPS,
            notes: NOTES,
            recipes: RECIPES,
            hint: "pass search or namespace to list entries",
          });
        }

        const prefix = namespace ? normalizeNamespace(namespace) : undefined;
        const needle = search?.toLowerCase();
        const max = limit ?? 50;
        const matches = (...fields: string[]): boolean =>
          !needle || fields.some((f) => f.toLowerCase().includes(needle));

        const result: Record<string, unknown> = { filter: { search, namespace: prefix } };
        if (prefix === "ym:uf:" || prefix === "ym:sf:") {
          result.note = `${prefix} only has step metrics ${prefix}devicesInStepN (not in the catalogue) — use get_funnel_report.`;
        }

        if (kind !== "dimensions") {
          const found = METRICS.filter((m) => (!prefix || m.key.startsWith(prefix)) && matches(m.key, m.name, m.description));
          result.metrics = {
            total: found.length,
            returned: Math.min(found.length, max),
            entries: found.slice(0, max).map((m) => ({
              key: m.key,
              name: m.name,
              description: m.description,
              type: m.type,
              page: m.page,
            })),
          };
        }

        if (kind !== "metrics") {
          const found = DIMENSIONS.filter(
            (d) => (!prefix || d.namespaces.includes(prefix)) && matches(d.suffix, d.name, d.description)
          );
          result.dimensions = {
            total: found.length,
            returned: Math.min(found.length, max),
            entries: found.slice(0, max).map((d) => ({
              suffix: d.suffix,
              name: d.name,
              description: d.description,
              namespaces: d.namespaces,
            })),
          };
        }

        return ok(result);
      } catch (e) {
        return err(e);
      }
    }
  );
}
