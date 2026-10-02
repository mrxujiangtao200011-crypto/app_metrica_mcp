import { z } from "zod";
import type { AppMetricaClient } from "./client.js";
import { dimensionLabel, listSavedFunnels, runFunnelReport, type SavedFunnel } from "./funnels.js";
import { combineFilters, resolveSegmentExpression } from "./segments.js";
import { namespaceOf, type ReportResponse } from "./util.js";

// AppMetrica web workspaces / "Обзор" are server-side dashboards behind an internal cookie-auth
// GraphQL endpoint — not reachable with an OAuth token. Dashboards here are widget sets computed
// from the public Reporting API.

type PresetDef = {
  title: string;
  namespace: string;
  metrics: string[];
  dimensions?: string[];
  limit?: number;
  sort?: string;
  needsCurrency?: boolean;
  special?: "funnels" | "retention";
};

const PRESETS = {
  audience: {
    title: "Audience",
    namespace: "ym:u",
    metrics: ["ym:u:activeUsers", "ym:u:newUsers", "ym:u:dormantUsers", "ym:u:resurrectedUsers"],
  },
  installs: {
    title: "Installs",
    namespace: "ym:i",
    metrics: ["ym:i:installDevices", "ym:i:installEvents"],
  },
  installs_by_country: {
    title: "Installs by country",
    namespace: "ym:i",
    metrics: ["ym:i:installDevices"],
    dimensions: ["ym:i:regionCountry"],
    limit: 10,
  },
  engagement: {
    title: "Engagement (sessions)",
    namespace: "ym:s",
    metrics: ["ym:s:sessions", "ym:s:sessionsPerUser", "ym:s:totalSessionDurationPerUser", "ym:s:avgSessionDuration"],
  },
  app_versions: {
    title: "App versions",
    namespace: "ym:u",
    metrics: ["ym:u:users"],
    dimensions: ["ym:u:appVersion"],
    limit: 10,
  },
  events: {
    title: "Top client events",
    namespace: "ym:ce",
    metrics: ["ym:ce:allEvents", "ym:ce:devices"],
    dimensions: ["ym:ce:eventLabel"],
    limit: 15,
    sort: "-ym:ce:allEvents",
  },
  crashes: {
    title: "Crashes",
    namespace: "ym:cr2",
    metrics: ["ym:cr2:crashes", "ym:cr2:crashDevices", "ym:cr2:crashesFreeSessionsPercentage", "ym:cr2:crashesFreeDevicesPercentage"],
  },
  errors: {
    title: "Errors",
    namespace: "ym:er2",
    metrics: ["ym:er2:errors", "ym:er2:errorDevices", "ym:er2:errorsFreeSessionsPercentage"],
  },
  anr: {
    title: "ANRs",
    namespace: "ym:anr2",
    metrics: ["ym:anr2:anrEvents", "ym:anr2:anrDevices", "ym:anr2:anrFreeSessionsPercentage"],
  },
  revenue: {
    title: "Revenue",
    namespace: "ym:r2",
    metrics: [
      "ym:r2:revenue<currency>",
      "ym:r2:revenuePerDevice<currency>",
      "ym:r2:purchases",
      "ym:r2:inappRevenue<currency>",
      "ym:r2:inappRevenueDevices",
    ],
    needsCurrency: true,
  },
  ad_revenue: {
    title: "Ad revenue",
    namespace: "ym:r2",
    metrics: [
      "ym:r2:adRevenue<currency>",
      "ym:r2:adRevenueDevices",
      "ym:r2:adRevenuePerDevice<currency>",
      "ym:r2:adRevenueECPM<currency>",
      "ym:r2:adRevenueDevicesPercentage",
    ],
    needsCurrency: true,
  },
  ad_revenue_by_type: {
    title: "Ad revenue by ad type",
    namespace: "ym:r2",
    metrics: ["ym:r2:adRevenue<currency>"],
    dimensions: ["ym:r2:adRevenueType"],
    limit: 10,
    needsCurrency: true,
  },
  conversions: {
    title: "Conversions (attributed events)",
    namespace: "ym:ae2",
    metrics: ["ym:ae2:attributedEvents", "ym:ae2:attributedDevices", "ym:ae2:attributedDevicesPercentage"],
  },
  traffic: {
    title: "Traffic sources",
    namespace: "ym:ts",
    metrics: ["ym:ts:advInstallDevices", "ym:ts:userClicks", "ym:ts:impressions", "ym:ts:clickToInstallConversion"],
  },
  push: {
    title: "Push campaigns",
    namespace: "ym:pc",
    metrics: ["ym:pc:sentDevices", "ym:pc:receivedDevices", "ym:pc:openedDevices", "ym:pc:eventsConversion"],
  },
  funnels: {
    title: "Saved funnels",
    namespace: "ym:uf",
    metrics: [],
    special: "funnels",
  },
  retention: {
    title: "Retention",
    namespace: "ym:u",
    metrics: [],
    special: "retention",
  },
} satisfies Record<string, PresetDef>;

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as [PresetName, ...PresetName[]];
export const DEFAULT_PRESETS: PresetName[] = ["audience", "installs", "engagement", "crashes", "events"];

export function describePresets() {
  return PRESET_NAMES.map((name) => {
    const p: PresetDef = PRESETS[name];
    return {
      name,
      title: p.title,
      namespace: p.namespace,
      metrics: p.metrics,
      dimensions: p.dimensions,
      limit: p.limit,
      sort: p.sort,
      needs_currency: p.needsCurrency,
      note:
        p.special === "funnels"
          ? "every saved funnel (list_funnels), one request per funnel"
          : p.special === "retention"
            ? "not available in the public API"
            : undefined,
    };
  });
}

// Exactly one of preset / metrics / funnel_id.
export const widgetSpecSchema = z.object({
  name: z.string().describe("Widget name"),
  preset: z.enum(PRESET_NAMES).optional().describe("Preset widget (see list_dashboard_presets)"),
  metrics: z.array(z.string()).optional().describe("Custom widget: metric keys of a single namespace"),
  dimensions: z.array(z.string()).optional().describe("Breakdown dimensions (full keys or bare suffixes of the metrics namespace)"),
  filters: z.string().optional().describe("Segmentation filter expression"),
  segment_id: z.number().optional().describe("Saved segment ID (list_segments)"),
  limit: z.number().optional().describe("Max rows for breakdown widgets"),
  funnel_id: z.number().optional().describe("Saved funnel widget (list_funnels)"),
});

export type WidgetSpec = z.infer<typeof widgetSpecSchema>;

export function validateWidgetSpec(w: WidgetSpec): void {
  const sources = [w.preset, w.metrics, w.funnel_id].filter((x) => x !== undefined).length;
  if (sources !== 1) {
    throw new Error(`Widget "${w.name}": specify exactly one of preset / metrics / funnel_id`);
  }
  if (w.metrics) {
    if (w.metrics.length === 0) throw new Error(`Widget "${w.name}": metrics must not be empty`);
    const namespaces = new Set([...w.metrics, ...(w.dimensions ?? []).filter((d) => d.startsWith("ym:"))].map(namespaceOf));
    if (namespaces.size > 1) {
      throw new Error(
        `Widget "${w.name}": mixes namespaces (${[...namespaces].join(", ")}); use one namespace per widget`
      );
    }
  }
}

export type DashboardInput = {
  appId: number;
  dateFrom: string;
  dateTo: string;
  widgets: WidgetSpec[];
  group?: "day" | "week" | "month";
  currency: string;
  segmentId?: number;
};

function numeric(x: unknown): number | undefined {
  return typeof x === "number" ? x : undefined;
}

// Sequential on purpose: Reporting API quota is 30 rps / 5000 requests per day.
export async function runDashboard(client: AppMetricaClient, input: DashboardInput) {
  const segmentCache = new Map<number, string>();
  const segmentExpr = async (id: number): Promise<string> => {
    let expr = segmentCache.get(id);
    if (expr === undefined) {
      expr = await resolveSegmentExpression(client, input.appId, id);
      segmentCache.set(id, expr);
    }
    return expr;
  };

  let funnelsCache: SavedFunnel[] | undefined;
  const savedFunnels = async (): Promise<SavedFunnel[]> => (funnelsCache ??= await listSavedFunnels(client, input.appId));

  const runWidget = async (widget: WidgetSpec): Promise<Record<string, unknown>> => {
    validateWidgetSpec(widget);
    const preset: PresetDef | undefined = widget.preset ? PRESETS[widget.preset] : undefined;

    // Dashboard-level segment AND widget-level segment AND widget filters.
    const segments = await Promise.all(
      [input.segmentId, widget.segment_id].filter((id): id is number => id !== undefined).map(segmentExpr)
    );
    const filters = combineFilters(segments.map((s) => `(${s})`).join(" and ") || undefined, widget.filters);

    if (preset?.special === "retention") {
      return {
        name: widget.name,
        title: preset.title,
        unavailable: true,
        note: "Retention is not available in the public Reporting API. Use export_logs (sessions_starts / installations) and compute cohorts, or the AppMetrica web UI.",
      };
    }

    const funnelReport = async (funnel: SavedFunnel) => {
      const r = await runFunnelReport(client, {
        appId: input.appId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        funnel,
        filters,
      });
      return { funnel: r.funnel, steps: r.steps, total_conversion: r.total_conversion, sampled: r.sampled };
    };

    if (preset?.special === "funnels") {
      const funnels = [];
      for (const f of await savedFunnels()) {
        try {
          funnels.push(await funnelReport(f));
        } catch (e) {
          funnels.push({ funnel: { id: f.id, name: f.name }, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { name: widget.name, title: preset.title, funnels };
    }

    if (widget.funnel_id !== undefined) {
      const funnel = (await savedFunnels()).find((f) => f.id === widget.funnel_id);
      if (!funnel) throw new Error(`Funnel ${widget.funnel_id} not found`);
      return { name: widget.name, title: funnel.name, ...(await funnelReport(funnel)) };
    }

    const metrics = preset ? preset.metrics : (widget.metrics as string[]);
    const namespace = namespaceOf(metrics[0]);
    const dimensions = (widget.dimensions ?? preset?.dimensions ?? []).map((d) => (d.startsWith("ym:") ? d : `${namespace}:${d}`));
    const bytime = input.group !== undefined && dimensions.length === 0;

    const params: Record<string, string | number | undefined> = {
      id: input.appId,
      metrics: metrics.join(","),
      dimensions: dimensions.length > 0 ? dimensions.join(",") : undefined,
      date1: input.dateFrom,
      date2: input.dateTo,
      filters,
      sort: preset?.sort,
      limit: widget.limit ?? preset?.limit,
      currency: metrics.some((m) => m.includes("<currency>")) ? input.currency : undefined,
    };
    if (bytime) params.group = input.group;

    const resp = await client.get<ReportResponse>(bytime ? "/stat/v1/data/bytime" : "/stat/v1/data", params);
    const first = resp.data?.[0];
    const out: Record<string, unknown> = { name: widget.name, title: preset?.title ?? widget.name };

    if (bytime) {
      // bytime has no period-wide total (unique counts are not additive) — series only.
      out.metrics = metrics.map((key, i) => ({
        key,
        total: numeric(resp.totals?.[i]),
        series: first?.metrics?.[i],
      }));
      out.time_intervals = resp.time_intervals;
    } else {
      const totals = Array.isArray(resp.totals) ? resp.totals : (first?.metrics ?? []);
      out.metrics = metrics.map((key, i) => ({ key, total: numeric(totals[i]) }));
      if (dimensions.length > 0) {
        out.rows = (resp.data ?? []).map((row) => ({
          dimensions: (row.dimensions ?? []).map(dimensionLabel),
          metrics: Object.fromEntries(metrics.map((key, i) => [key, row.metrics?.[i]])),
        }));
      }
    }
    if (resp.sampled) {
      out.sampled = true;
      out.sample_share = resp.sample_share;
    }
    return out;
  };

  const widgets: Array<Record<string, unknown>> = [];
  for (const widget of input.widgets) {
    try {
      widgets.push(await runWidget(widget));
    } catch (e) {
      widgets.push({ name: widget.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    app_id: input.appId,
    period: { date_from: input.dateFrom, date_to: input.dateTo },
    group: input.group,
    currency: input.currency,
    widgets,
  };
}
