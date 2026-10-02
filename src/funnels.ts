import type { AppMetricaClient } from "./client.js";
import type { ReportResponse } from "./util.js";

export type FunnelStepKind =
  | "client_events"
  | "install"
  | "session_start"
  | "crash"
  | "error"
  | "purchase"
  | "ad_revenue"
  | "deeplink"
  | "any_event";

export type FunnelStepInput = {
  title?: string;
  events?: string[];
  event_params?: Array<{ key: string; value: string }>;
  kind?: FunnelStepKind;
};

export type FunnelBuildOptions = {
  foregroundOnly: boolean;
  singleSession: boolean;
  eventsBetweenSteps: boolean;
};

export type FunnelPattern = {
  pattern: string;
  restriction?: string;
  metricNamespace: "ym:uf" | "ym:sf";
};

// Escape `'` and `\` inside string literals.
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Predicate of one step. Multi-part predicates are already parenthesised, so the
// foreground clause can be appended with a plain "and".
function stepPredicate(step: FunnelStepInput, index: number): string {
  const kind = step.kind ?? "client_events";
  switch (kind) {
    case "client_events": {
      if (!step.events || step.events.length === 0) {
        throw new Error(`Funnel step ${index + 1}: "events" is required for kind client_events`);
      }
      const params = (step.event_params ?? [])
        .map((p) => ` and exists(paramsLevel1=='${esc(p.key)}' and paramsLevel2=='${esc(p.value)}')`)
        .join("");
      const parts = step.events.map((e) => `eventType=='EVENT_CLIENT' and eventLabel=='${esc(e)}'${params}`);
      return parts.length === 1 ? parts[0] : `(${parts.map((p) => `(${p})`).join(" or ")})`;
    }
    case "install":
      return "eventType=='EVENT_AD_INSTALL'";
    case "session_start":
      return "eventType=='EVENT_START'";
    case "crash":
      return "(eventType=='EVENT_PROTOBUF_CRASH' or eventType=='EVENT_CRASH')";
    case "error":
      return "(eventType=='EVENT_PROTOBUF_ERROR' or eventType=='EVENT_ERROR')";
    case "purchase":
      return "eventType=='EVENT_REVENUE' and inappRevenueEvent=='yes'";
    case "ad_revenue":
      return "eventType=='EVENT_AD_REVENUE'";
    case "deeplink":
      return "eventType=='EVENT_OPEN'";
    case "any_event":
      return "isAnyEvent=='yes'";
    default:
      throw new Error(`Funnel step ${index + 1}: unknown kind "${String(kind)}"`);
  }
}

export function buildFunnelPattern(steps: FunnelStepInput[], opts: FunnelBuildOptions): FunnelPattern {
  if (steps.length === 0) throw new Error("Funnel needs at least one step");

  const condNs = opts.singleSession ? "ym:sft" : "ym:uft";
  const predicates = steps.map((s, i) => stepPredicate(s, i));
  const conds = predicates.map((p) => `cond(${condNs}, ${opts.foregroundOnly ? `${p} and sessionType=='foreground'` : p})`);

  const result: FunnelPattern = {
    pattern: conds.join(opts.eventsBetweenSteps ? "  " : " next "),
    metricNamespace: opts.singleSession ? "ym:sf" : "ym:uf",
  };
  if (!opts.eventsBetweenSteps) result.restriction = predicates.map((p) => `(${p})`).join(" or ");
  return result;
}

export type ParsedFunnelStep = {
  title: string;
  events: string[];
  kind: FunnelStepKind | "other";
  raw?: unknown;
};

export type ParsedFrontendPattern = {
  steps: ParsedFunnelStep[];
  singleSession: boolean;
  eventsBetweenSteps: boolean;
  grouping: string;
};

// `frontend_pattern` of a saved funnel is a JSON string produced by the web UI. Tolerant:
// invalid JSON yields an empty step list, unknown filter tags yield kind "other" with the raw step.
export function parseFrontendPattern(json: string): ParsedFrontendPattern {
  const result: ParsedFrontendPattern = { steps: [], singleSession: false, eventsBetweenSteps: true, grouping: "users" };
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== "object") return result;

  if (typeof parsed.singleSession === "boolean") result.singleSession = parsed.singleSession;
  if (typeof parsed.eventsBetweenSteps === "boolean") result.eventsBetweenSteps = parsed.eventsBetweenSteps;
  if (typeof parsed.grouping === "string") result.grouping = parsed.grouping;

  const rawSteps: any[] = Array.isArray(parsed.steps) ? parsed.steps : [];
  result.steps = rawSteps.map((raw, i) => {
    const title = typeof raw?.title === "string" ? raw.title : `Step ${i + 1}`;
    const filters: any[] = Array.isArray(raw?.filters) ? raw.filters : [];
    const events: string[] = [];
    let kind: ParsedFunnelStep["kind"] | undefined;
    let known = true;
    for (const f of filters) {
      if (f?.tag === "event") {
        kind ??= "client_events";
        for (const item of Array.isArray(f.items) ? f.items : []) {
          const name = item?.path?.[0];
          if (typeof name === "string") events.push(name);
        }
      } else if (f?.tag === "install") {
        kind ??= "install";
      } else {
        known = false;
      }
    }
    if (!known || kind === undefined) return { title, events, kind: "other", raw };
    return { title, events, kind };
  });
  return result;
}

// Dimension values come as objects like { id, name, ... } — keep the readable part.
export function dimensionLabel(d: Record<string, unknown>): unknown {
  return d.name ?? d.id ?? d;
}

export type SavedFunnel = {
  id: number;
  name: string;
  comment?: string;
  pattern_type?: string;
  pattern: string;
  frontend_pattern?: string;
  owner?: string;
  edit_access?: boolean;
};

export async function listSavedFunnels(client: AppMetricaClient, appId: number): Promise<SavedFunnel[]> {
  const data = await client.get<{ funnels?: SavedFunnel[] }>(`/management/v1/application/${appId}/funnels`);
  return data.funnels ?? [];
}

export type FunnelReportInput = {
  appId: number;
  dateFrom: string;
  dateTo: string;
  // Exactly one of funnel (saved, pattern used verbatim) / steps (ad-hoc, built via buildFunnelPattern).
  funnel?: SavedFunnel;
  steps?: FunnelStepInput[];
  foregroundOnly?: boolean;
  singleSession?: boolean;
  eventsBetweenSteps?: boolean;
  windowSeconds?: number;
  dimensions?: string[];
  filters?: string; // final expression (segment already resolved and combined)
  group?: "day" | "week" | "month";
  limit?: number;
};

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function defaultTitle(step: FunnelStepInput, index: number): string {
  if (step.title) return step.title;
  if ((step.kind ?? "client_events") === "client_events") return (step.events ?? []).join(" / ") || `Step ${index + 1}`;
  return step.kind as string;
}

export type FunnelReportResult = {
  funnel: { id?: number; name?: string; steps: string[] };
  period: { date_from: string; date_to: string };
  api: { pattern: string; restriction?: string; metrics: string[] };
  note?: string;
  steps: Array<{
    index: number;
    title: string;
    devices: number;
    absolute_conversion: number | null;
    relative_conversion: number | null;
  }>;
  total_conversion: number | null;
  rows?: Array<{ dimensions: unknown[]; steps: number[] }>;
  series?: { time_intervals?: unknown[]; steps?: unknown[]; rows?: Array<{ dimensions: unknown[]; steps: unknown[] }> };
  sampled?: boolean;
  sample_share?: number;
};

export async function runFunnelReport(client: AppMetricaClient, input: FunnelReportInput): Promise<FunnelReportResult> {
  if (Boolean(input.funnel) === Boolean(input.steps)) {
    throw new Error("Specify exactly one of funnel_id / steps");
  }

  let pattern: string;
  let restriction: string | undefined;
  let ns: "ym:uf" | "ym:sf";
  let titles: string[];
  let restrictionNote: string | undefined;

  if (input.funnel) {
    const parsed = parseFrontendPattern(input.funnel.frontend_pattern ?? "");
    pattern = input.funnel.pattern;
    ns = parsed.singleSession || pattern.includes("cond(ym:sft") ? "ym:sf" : "ym:uf";
    // The saved pattern is authoritative for the number of steps; titles come from the editor JSON.
    const count = (pattern.match(/cond\(/g) ?? []).length || parsed.steps.length;
    titles = Array.from({ length: count }, (_, i) => parsed.steps[i]?.title ?? `Step ${i + 1}`);
    if (!parsed.eventsBetweenSteps) {
      // The web UI derives funnel_restriction at query time from the steps; mirror it.
      try {
        restriction = buildFunnelPattern(stepsFromFrontendPattern(input.funnel.frontend_pattern ?? ""), {
          foregroundOnly: pattern.includes("sessionType=='foreground'"),
          singleSession: parsed.singleSession,
          eventsBetweenSteps: false,
        }).restriction;
      } catch {
        restriction = undefined;
        restrictionNote = "Saved funnel has 'events between steps' off, but its restriction could not be rebuilt from the editor steps; the report ran without funnel_restriction.";
      }
    }
  } else {
    const steps = input.steps as FunnelStepInput[];
    const built = buildFunnelPattern(steps, {
      foregroundOnly: input.foregroundOnly ?? true,
      singleSession: input.singleSession ?? false,
      eventsBetweenSteps: input.eventsBetweenSteps ?? true,
    });
    pattern = built.pattern;
    restriction = built.restriction;
    ns = built.metricNamespace;
    titles = steps.map(defaultTitle);
  }
  if (titles.length === 0) throw new Error("Funnel has no steps");

  const metrics = titles.map((_, i) => `${ns}:devicesInStep${i + 1}`);
  const dimensions = (input.dimensions ?? []).map((d) => (d.startsWith("ym:") ? d : `${ns}:${d}`));

  const params: Record<string, string | number | undefined> = {
    id: input.appId,
    date1: input.dateFrom,
    date2: input.dateTo,
    funnel_pattern: pattern,
    funnel_restriction: restriction,
    funnel_window: input.windowSeconds,
    metrics: metrics.join(","),
    dimensions: dimensions.length > 0 ? dimensions.join(",") : undefined,
    filters: input.filters,
    limit: input.limit ?? 50,
  };

  const resp = await client.get<ReportResponse>("/stat/v1/data", params);
  const totals = Array.isArray(resp.totals) ? resp.totals : (resp.data?.[0]?.metrics ?? []);
  const devices = metrics.map((_, i) => Number(totals[i] ?? 0));
  const first = devices[0];
  const last = devices[devices.length - 1];

  const result: FunnelReportResult = {
    funnel: { id: input.funnel?.id, name: input.funnel?.name, steps: titles },
    period: { date_from: input.dateFrom, date_to: input.dateTo },
    api: { pattern, restriction, metrics },
    ...(restrictionNote ? { note: restrictionNote } : {}),
    steps: devices.map((d, i) => ({
      index: i + 1,
      title: titles[i],
      devices: d,
      absolute_conversion: first > 0 ? round1((d / first) * 100) : null,
      relative_conversion: i === 0 ? (first > 0 ? 100 : null) : devices[i - 1] > 0 ? round1((d / devices[i - 1]) * 100) : null,
    })),
    total_conversion: first > 0 ? round1((last / first) * 100) : null,
  };

  if (dimensions.length > 0) {
    result.rows = (resp.data ?? []).map((row) => ({
      dimensions: (row.dimensions ?? []).map(dimensionLabel),
      steps: (row.metrics ?? []).map(Number),
    }));
  }

  if (input.group) {
    // Period totals above come from /data (unique counts are not additive across intervals);
    // the per-interval series needs one extra /data/bytime request.
    const bt = await client.get<ReportResponse>("/stat/v1/data/bytime", { ...params, group: input.group });
    const rows = (bt.data ?? []).map((row) => ({
      dimensions: (row.dimensions ?? []).map(dimensionLabel),
      steps: row.metrics ?? [],
    }));
    result.series =
      dimensions.length > 0
        ? { time_intervals: bt.time_intervals, rows }
        : { time_intervals: bt.time_intervals, steps: rows[0]?.steps ?? [] };
  }

  result.sampled = resp.sampled;
  result.sample_share = resp.sample_share;
  return result;
}

// ---- Saved funnels (write side) ----

export type SavedFunnelBody = {
  name: string;
  comment: string;
  pattern_type: string;
  pattern: string;
  frontend_pattern: string;
};

function notRepresentable(index: number, what: string): Error {
  return new Error(
    `Funnel step ${index + 1}: ${what} is not representable in the AppMetrica funnel editor; use get_funnel_report for ad-hoc analysis`
  );
}

// JSON string stored as `frontend_pattern` (what the web funnel editor renders). Only `client_events`
// (at most one event_params entry, applied to every event of the step) and `install` steps are representable.
export function buildFrontendPattern(steps: FunnelStepInput[], opts: FunnelBuildOptions): string {
  if (steps.length === 0) throw new Error("Funnel needs at least one step");

  const out = steps.map((step, i) => {
    const kind = step.kind ?? "client_events";
    if (kind === "install") {
      return { title: step.title ?? "Install", filters: [{ tag: "install" }] };
    }
    if (kind !== "client_events") throw notRepresentable(i, `kind "${kind}"`);
    if (!step.events || step.events.length === 0) {
      throw new Error(`Funnel step ${i + 1}: "events" is required for kind client_events`);
    }
    const params = step.event_params ?? [];
    if (params.length > 1) throw notRepresentable(i, "more than one event_params entry");
    const tail = params.length === 1 ? [params[0].key, params[0].value] : [];
    return {
      title: step.title ?? step.events.join(" / "),
      filters: [{ tag: "event", combinePolicy: "and", items: step.events.map((e) => ({ path: [e, ...tail] })) }],
    };
  });

  return JSON.stringify({
    steps: out,
    singleSession: opts.singleSession,
    eventsBetweenSteps: opts.eventsBetweenSteps,
    grouping: opts.foregroundOnly ? "users" : "devices",
  });
}

// Body of create/update requests. Saved patterns end with a trailing space after the last cond(...).
export function buildSavedFunnelBody(
  name: string,
  comment: string,
  steps: FunnelStepInput[],
  opts: FunnelBuildOptions
): SavedFunnelBody {
  const frontend_pattern = buildFrontendPattern(steps, opts);
  const { pattern } = buildFunnelPattern(steps, opts);
  return { name, comment, pattern_type: "user", pattern: `${pattern} `, frontend_pattern };
}

// Inverse of buildFrontendPattern, used by update_funnel to keep the existing steps when only options change.
export function stepsFromFrontendPattern(json: string): FunnelStepInput[] {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Saved funnel has an unreadable frontend_pattern; pass steps explicitly");
  }
  const rawSteps: any[] = Array.isArray(parsed?.steps) ? parsed.steps : [];
  return rawSteps.map((raw, i) => {
    const title: string | undefined = typeof raw?.title === "string" ? raw.title : undefined;
    const filters: any[] = Array.isArray(raw?.filters) ? raw.filters : [];
    if (filters.length === 1 && filters[0]?.tag === "install") return { title, kind: "install" as const };
    if (filters.length === 1 && filters[0]?.tag === "event") {
      const items: any[] = Array.isArray(filters[0].items) ? filters[0].items : [];
      const paths: unknown[][] = items.map((it) => (Array.isArray(it?.path) ? it.path : []));
      const events = paths.map((p) => p[0]).filter((e): e is string => typeof e === "string");
      const tail = paths[0]?.slice(1) ?? [];
      const sameTail = paths.every((p) => JSON.stringify(p.slice(1)) === JSON.stringify(tail));
      if (events.length > 0 && sameTail && (tail.length === 0 || (tail.length === 2 && tail.every((t) => typeof t === "string")))) {
        return { title, events, event_params: tail.length === 2 ? [{ key: tail[0] as string, value: tail[1] as string }] : undefined };
      }
    }
    throw new Error(
      `Saved funnel step ${i + 1} ("${title ?? ""}") cannot be rebuilt from its frontend_pattern; pass steps explicitly or update only name/comment`
    );
  });
}

export async function createFunnel(client: AppMetricaClient, appId: number, body: SavedFunnelBody): Promise<SavedFunnel> {
  const data = await client.post<{ funnel: SavedFunnel }>(`/management/v1/application/${appId}/funnel`, { funnel: body });
  return data.funnel;
}

export async function updateFunnel(
  client: AppMetricaClient,
  appId: number,
  funnelId: number,
  body: SavedFunnelBody
): Promise<SavedFunnel> {
  const data = await client.put<{ funnel: SavedFunnel }>(`/management/v1/application/${appId}/funnel/${funnelId}`, {
    funnel: body,
  });
  return data.funnel;
}

export async function deleteFunnel(client: AppMetricaClient, appId: number, funnelId: number): Promise<unknown> {
  return client.delete<unknown>(`/management/v1/application/${appId}/funnel/${funnelId}`);
}
