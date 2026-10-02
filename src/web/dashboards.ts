// Experimental: typed wrappers over the AppMetrica web client's GraphQL operations for workspaces
// (dashboards) and their widgets — the part of the product the public API cannot manage.
// Everything goes through one lazily created headless Chrome session (see ./session.ts).
import type { PresetName, WidgetSpec } from "../dashboards.js";
import type { SavedFunnel } from "../funnels.js";
import { buildDocument, type WebOperationName } from "./operations.js";
import { WebSession } from "./session.js";

let session: WebSession | undefined;

// One shared session per process; Chrome is closed when the MCP server exits.
export function webSession(): WebSession {
  if (!session) {
    const s = new WebSession();
    session = s;
    process.on("exit", () => {
      void s.close();
    });
    process.once("SIGINT", () => {
      void s.close().finally(() => process.exit(130));
    });
    // An MCP client that just closes stdin would otherwise leave node + headless Chrome alive.
    process.stdin.once("end", () => {
      void s.close().finally(() => process.exit(0));
    });
  }
  return session;
}

function gql<T>(name: WebOperationName, variables: Record<string, unknown>): Promise<T> {
  const clean = Object.fromEntries(Object.entries(variables).filter(([, v]) => v !== undefined));
  return webSession().gql<T>(name, buildDocument(name), clean);
}

function asList<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : data ? [data as T] : [];
}

// ---------------------------------------------------------------------------------------------
// Entities (only the fields we use)

export type DashboardWidget = {
  dashboardWidgetId: string;
  widgetId: string;
  viewKind?: string | null;
  selectedMetricId?: string | null;
  selectedDimensionId?: string | null;
  funnelId?: string | null;
};

export type DashboardGroup = {
  dashboardWidgetGroupId: string;
  header?: { title?: string | null; subtitle?: string | null; isDisabled?: boolean | null } | null;
  widgets?: DashboardWidget[] | null;
};

export type DashboardEntity = {
  dashboardId: string;
  isSystem?: boolean | null;
  presetKind?: string | null;
  name?: string | null;
  sourceId?: string | null;
  widgetsGroups?: DashboardGroup[] | null;
  isEditable?: boolean | null;
  isRemovable?: boolean | null;
};

type Attr = { id: string };

export type WidgetEntity = {
  widgetId: string;
  name?: string | null;
  namespace?: string | null;
  categoryIds?: string[] | null;
  metrics?: Attr[] | null;
  dimensions?: Attr[] | null;
  defaultViewKind?: string | null;
  funnelId?: string | null;
};

type Meta = { id: string; title?: string | null };

export type NamespaceEntity = {
  id: string;
  name?: string | null;
  apiTableId?: string | null;
  metrics?: Meta[] | null;
  dimensions?: Meta[] | null;
};

// ---------------------------------------------------------------------------------------------
// Operations

// `orgId` is not needed: the web API accepts a bare source id list.
export function sourceDescriptor(appId: number | string): { sourceIds: string[] } {
  return { sourceIds: [String(appId)] };
}

export function dashboardUrl(appId: number | string, dashboardId: string): string {
  return `https://appmetrica.yandex.ru/dashboard?dashboardId=${encodeURIComponent(dashboardId)}&appId=${appId}`;
}

export async function listDashboards(appId: number): Promise<DashboardEntity[]> {
  return asList(await gql("dashboards", { sourceDescriptor: sourceDescriptor(appId) }));
}

export async function getDashboard(appId: number, dashboardId: string): Promise<DashboardEntity> {
  const dashboard = await gql<DashboardEntity | null>("dashboard", { dashboardId, sourceDescriptor: sourceDescriptor(appId) });
  if (!dashboard) throw new Error(`Workspace "${dashboardId}" not found for app ${appId}`);
  return dashboard;
}

// Preset widgets (categoryIds set) and the app's custom widgets (uuid widgetId, categoryIds null).
export async function listWidgets(appId: number): Promise<WidgetEntity[]> {
  return asList(await gql("widgets", { sourceDescriptor: sourceDescriptor(appId) }));
}

export async function listNamespaces(appId: number): Promise<NamespaceEntity[]> {
  return asList(await gql("availableNamespaces2", { sourceDescriptor: sourceDescriptor(appId) }));
}

export async function getNamespace(appId: number, namespaceId: string): Promise<NamespaceEntity> {
  const data = await gql<NamespaceEntity | NamespaceEntity[]>("namespaceMetadata2", {
    sourceDescriptor: sourceDescriptor(appId),
    namespaceId,
  });
  return Array.isArray(data) ? (data.find((n) => n.id === namespaceId) ?? data[0]) : data;
}

// Widget as the mutations expect it: an existing widget (preset / saved custom) or an inline custom one.
export type WidgetMutationInput =
  | { widgetId: string; settings: { viewKind: string; funnelId?: string } }
  | {
      widget: {
        name: string;
        namespace: string;
        metrics: Array<{ id: string }>;
        dimensions: Array<{ id: string }>;
        segment: string;
      };
      settings: { viewKind: string };
    };

export type GroupMutationInput = { header: { title: string } } | { widgets: WidgetMutationInput[] };

export async function createDashboard(
  appId: number,
  name: string,
  groups: GroupInput[] = [],
  cache: NormalizeCache = newNormalizeCache()
): Promise<DashboardEntity> {
  const widgetsGroups = groups.length > 0 ? await normalizeGroups(appId, groups, cache) : undefined;
  return gql("createDashboard3", { name, widgetsGroups, sourceDescriptor: sourceDescriptor(appId) });
}

export async function addWidgetGroup(
  appId: number,
  dashboardId: string,
  widgets: WidgetInput[],
  position?: number,
  cache: NormalizeCache = newNormalizeCache()
): Promise<unknown> {
  const normalized = await normalizeWidgets(appId, widgets, cache);
  return gql("createDashboardWidgetGroup", {
    dashboardId,
    widgets: normalized,
    position,
    sourceDescriptor: sourceDescriptor(appId),
  });
}

export async function addHeader(appId: number, dashboardId: string, title: string, position?: number): Promise<DashboardGroup> {
  return gql("createDashboardWidgetHeader", {
    dashboardId,
    header: { title },
    position,
    sourceDescriptor: sourceDescriptor(appId),
  });
}

export async function renameDashboard(appId: number, dashboardId: string, name: string): Promise<unknown> {
  return gql("updateDashboardName3", { dashboardId, name, sourceDescriptor: sourceDescriptor(appId) });
}

export async function removeWidget(appId: number, dashboardId: string, dashboardWidgetId: string): Promise<unknown> {
  return gql("removeDashboardWidget", { dashboardId, dashboardWidgetId, sourceDescriptor: sourceDescriptor(appId) });
}

export async function removeDashboard(appId: number, dashboardId: string): Promise<unknown> {
  return gql("removeDashboard3", { dashboardId, sourceDescriptor: sourceDescriptor(appId) });
}

// ---------------------------------------------------------------------------------------------
// Widget input normalisation

export type WidgetInput = {
  // Web preset widget id (see web_list_widget_presets) or an existing custom widget uuid.
  preset?: string;
  // Saved funnel id -> `Funnels` preset widget bound to that funnel.
  funnel_id?: number;
  // Custom widget.
  name?: string;
  namespace?: string;
  metrics?: string[];
  dimensions?: string[];
  segment_id?: number;
  view_kind?: string;
};

export type GroupInput = { header?: string; widgets?: WidgetInput[] };

// Per-call cache so a multi-widget request fetches `widgets` / namespaces / metadata once.
export type NormalizeCache = {
  widgets?: Promise<WidgetEntity[]>;
  namespaces?: Promise<NamespaceEntity[]>;
  metadata: Map<string, Promise<NamespaceEntity>>;
};

export function newNormalizeCache(): NormalizeCache {
  return { metadata: new Map() };
}

// Namespaces sharing one Reporting API prefix: which one the web UI uses for new custom widgets.
const PREFERRED_NAMESPACE: Record<string, string> = { "ym:i": "Cohort", "ym:ts": "UserAcquisition" };

const V1_TO_V2_PREFIX: Record<string, string> = {
  "ym:ce:": "ym:ce2:",
  "ym:cr:": "ym:cr2:",
  "ym:r:": "ym:r2:",
  "ym:er:": "ym:er2:",
  "ym:anr:": "ym:anr2:",
  "ym:ae:": "ym:ae2:",
  "ym:ec:": "ym:ec2:",
};

function upgradePrefix(id: string): string {
  const m = /^(ym:[a-z]+:)/.exec(id);
  const to = m ? V1_TO_V2_PREFIX[m[1]] : undefined;
  return to ? to + id.slice(m![1].length) : id;
}

const tail = (id: string): string => (id.split(":").pop() ?? id).toLowerCase();

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Ids containing the typed name first, then near misses by edit distance.
function similar(input: string, known: string[]): string[] {
  const t = tail(input);
  const contains = known.filter((id) => tail(id).includes(t) || t.includes(tail(id)));
  const near = known
    .filter((id) => !contains.includes(id))
    .map((id) => ({ id, d: editDistance(t, tail(id)) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(t.length / 3)))
    .sort((x, y) => x.d - y.d)
    .map((x) => x.id);
  return [...contains, ...near].slice(0, 8);
}

function resolveAttr(kind: "metric" | "dimension", input: string, ns: NamespaceEntity, known: string[]): string {
  // Nothing to validate against (metadata came back empty) — pass the id through.
  if (known.length === 0) return input;
  const prefix = ns.apiTableId ?? "";
  const candidates = [input];
  if (!input.startsWith("ym:") && prefix) candidates.push(prefix + input);
  if (prefix && input.startsWith(prefix)) candidates.push(input.slice(prefix.length));
  const set = new Set(known);
  for (const c of candidates) if (set.has(c)) return c;
  const lower = new Map(known.map((id) => [id.toLowerCase(), id]));
  for (const c of candidates) {
    const hit = lower.get(c.toLowerCase());
    if (hit) return hit;
  }
  const hits = similar(input, known);
  throw new Error(
    `Unknown ${kind} "${input}" in namespace ${ns.id}.` +
      (hits.length > 0
        ? ` Similar: ${hits.join(", ")}.`
        : ` Use web_list_report_namespaces(namespace_id="${ns.id}") to see valid ${kind} ids.`)
  );
}

function namespaceList(namespaces: NamespaceEntity[]): string {
  return namespaces.map((n) => `${n.id} (${n.apiTableId ?? "no prefix"})`).join(", ");
}

async function pickNamespace(
  appId: number,
  input: WidgetInput,
  cache: NormalizeCache
): Promise<NamespaceEntity> {
  const namespaces = await (cache.namespaces ??= listNamespaces(appId));
  if (input.namespace) {
    const wanted = input.namespace.toLowerCase();
    const found = namespaces.find((n) => n.id.toLowerCase() === wanted);
    if (!found) throw new Error(`Unknown namespace "${input.namespace}". Valid namespaces: ${namespaceList(namespaces)}`);
    return found;
  }
  const first = (input.metrics ?? [])[0];
  const prefix = /^(ym:[A-Za-z0-9]+):/.exec(first)?.[1];
  if (!prefix) {
    throw new Error(
      `Cannot derive the namespace from metric "${first}": use full Reporting API keys like ym:u:users, or pass namespace. Valid namespaces: ${namespaceList(namespaces)}`
    );
  }
  const matches = namespaces.filter((n) => (n.apiTableId ?? "").replace(/:$/, "") === prefix);
  if (matches.length === 0) {
    throw new Error(`No namespace has the prefix ${prefix}: for metric "${first}". Valid namespaces: ${namespaceList(namespaces)}`);
  }
  if (matches.length === 1) return matches[0];
  const preferred = matches.find((n) => n.id === PREFERRED_NAMESPACE[prefix]);
  if (preferred) return preferred;
  return [...matches].sort(
    (a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)) || (b.metrics?.length ?? 0) - (a.metrics?.length ?? 0)
  )[0];
}

export async function normalizeWidget(
  appId: number,
  input: WidgetInput,
  cache: NormalizeCache = newNormalizeCache()
): Promise<WidgetMutationInput> {
  const hasMetrics = (input.metrics?.length ?? 0) > 0;
  const isFunnel = input.funnel_id !== undefined || input.preset?.toLowerCase() === "funnels";

  if (isFunnel) {
    if (input.funnel_id === undefined) throw new Error('Preset "Funnels" needs funnel_id (list_funnels)');
    if (hasMetrics) throw new Error("A funnel widget cannot have metrics; use either funnel_id or metrics");
    return { widgetId: "Funnels", settings: { viewKind: input.view_kind ?? "FunnelFirstStep", funnelId: String(input.funnel_id) } };
  }

  if (input.preset !== undefined) {
    if (hasMetrics) throw new Error("Specify exactly one of preset / funnel_id / metrics per widget");
    const widgets = await (cache.widgets ??= listWidgets(appId));
    const wanted = input.preset.toLowerCase();
    const found = widgets.find((w) => w.widgetId === input.preset) ?? widgets.find((w) => w.widgetId.toLowerCase() === wanted);
    if (!found) {
      const ids = widgets.filter((w) => w.categoryIds).map((w) => w.widgetId);
      throw new Error(`Unknown widget preset "${input.preset}". Available presets: ${ids.join(", ")}`);
    }
    return { widgetId: found.widgetId, settings: { viewKind: input.view_kind ?? found.defaultViewKind ?? "Timeline" } };
  }

  if (!hasMetrics) throw new Error("Specify exactly one of preset / funnel_id / metrics per widget");
  // The web report namespaces live on the "join" tables (ym:ce2:, ym:cr2:, ym:r2:, …); the plain
  // prefixes only back degenerate segmentation namespaces with a single metric. Upgrade them so
  // Reporting API keys like ym:ce:allEvents land in the Events namespace as ym:ce2:allEvents.
  const upgraded = input.namespace ? input : { ...input, metrics: input.metrics?.map(upgradePrefix), dimensions: input.dimensions?.map(upgradePrefix) };
  const metrics = upgraded.metrics as string[];
  input = upgraded;
  const ns = await pickNamespace(appId, input, cache);
  let metaPromise = cache.metadata.get(ns.id);
  if (!metaPromise) {
    metaPromise = getNamespace(appId, ns.id);
    cache.metadata.set(ns.id, metaPromise);
  }
  const meta = await metaPromise;
  const knownMetrics = (meta.metrics ?? []).map((m) => m.id);
  const knownDimensions = (meta.dimensions ?? []).map((d) => d.id);
  const metricIds = metrics.map((m) => resolveAttr("metric", m, ns, knownMetrics));
  const dimensionIds = (input.dimensions ?? []).map((d) => resolveAttr("dimension", d, ns, knownDimensions));
  const title = (meta.metrics ?? []).find((m) => m.id === metricIds[0])?.title;
  return {
    widget: {
      name: input.name ?? title ?? metricIds[0],
      namespace: ns.id,
      metrics: metricIds.map((id) => ({ id })),
      dimensions: dimensionIds.map((id) => ({ id })),
      segment: input.segment_id ? String(input.segment_id) : "null",
    },
    settings: { viewKind: input.view_kind ?? "Timeline" },
  };
}

export async function normalizeWidgets(appId: number, inputs: WidgetInput[], cache: NormalizeCache = newNormalizeCache()): Promise<WidgetMutationInput[]> {
  const out: WidgetMutationInput[] = [];
  for (const input of inputs) out.push(await normalizeWidget(appId, input, cache));
  return out;
}

// A group with both header and widgets becomes two consecutive groups (header row, widgets row):
// the two forms `{header}` / `{widgets}` are the verified shapes of `widgetsGroups`.
export async function normalizeGroups(appId: number, groups: GroupInput[], cache: NormalizeCache = newNormalizeCache()): Promise<GroupMutationInput[]> {
  const out: GroupMutationInput[] = [];
  for (const group of groups) {
    if (group.header === undefined && (group.widgets?.length ?? 0) === 0) throw new Error("A group needs a header and/or widgets");
    if (group.header !== undefined) out.push({ header: { title: group.header } });
    if ((group.widgets?.length ?? 0) > 0) out.push({ widgets: await normalizeWidgets(appId, group.widgets as WidgetInput[], cache) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Output shaping

export function summarizeDashboard(d: DashboardEntity) {
  const groups = d.widgetsGroups ?? [];
  return {
    dashboard_id: d.dashboardId,
    name: d.name,
    is_system: Boolean(d.isSystem),
    preset_kind: d.presetKind ?? undefined,
    groups: groups.length,
    widgets: groups.reduce((n, g) => n + (g.widgets?.length ?? 0), 0),
  };
}

export function describeGroups(d: DashboardEntity, widgets: WidgetEntity[] = []) {
  const byId = new Map(widgets.map((w) => [w.widgetId, w]));
  return (d.widgetsGroups ?? []).map((g) => ({
    group_id: g.dashboardWidgetGroupId,
    header: g.header?.title ?? undefined,
    widgets: (g.widgets ?? []).map((w) => {
      const meta = byId.get(w.widgetId);
      return {
        dashboard_widget_id: w.dashboardWidgetId,
        widget_id: w.widgetId,
        view_kind: w.viewKind ?? undefined,
        funnel_id: w.funnelId ?? undefined,
        name: meta?.name ?? undefined,
        namespace: meta?.namespace ?? undefined,
        metrics: meta?.metrics?.map((m) => m.id),
        dimensions: meta?.dimensions?.map((m) => m.id),
      };
    }),
  }));
}

// ---------------------------------------------------------------------------------------------
// Local workspace -> web widgets

type Mapping =
  | { presets: string[] }
  | { custom: { namespace?: string; metrics: string[]; dimensions?: string[] } }
  | { funnels: true };

// Local preset -> web counterpart. Custom entries have no preset in the web UI.
const LOCAL_TO_WEB = {
  audience: { presets: ["AudienceMulti"] },
  installs: { presets: ["Installs"] },
  installs_by_country: { custom: { namespace: "Cohort", metrics: ["ym:i:installDevices"], dimensions: ["ym:i:regionCountry"] } },
  engagement: { presets: ["UserTimeSpent", "AvgSessionTime", "UserSessionsCount"] },
  app_versions: { presets: ["AppVersion"] },
  events: { custom: { namespace: "Events", metrics: ["ym:ce2:allEvents"], dimensions: ["ym:ce2:eventLabel"] } },
  crashes: { presets: ["CrashFreeSessions", "Crashes"] },
  errors: { presets: ["ErrorLogsIos", "ErrorLogsAndroid"] },
  revenue: { presets: ["RevenueTotal", "RevenuePurchases"] },
  ad_revenue: { presets: ["AdRevenue", "AdRevenueARPU", "AdRevenueECPM"] },
  ad_revenue_by_type: { custom: { metrics: ["ym:r2:adRevenue<currency>"], dimensions: ["ym:r2:adRevenueType"] } },
  conversions: { custom: { namespace: "Conversions", metrics: ["ym:ae2:attributedEvents"] } },
  traffic: { presets: ["Clicks", "Installs", "InstallConversion"] },
  push: { presets: ["PushSent", "PushReceived", "PushOpened"] },
  funnels: { funnels: true },
  retention: { presets: ["RetentionDynamics"] },
  anr: { custom: { namespace: "AnrLogs", metrics: ["ym:anr2:anrEvents"] } },
} satisfies Record<PresetName, Mapping>;

// Maps one local workspace widget to web widget inputs (one row). Throws when there is no counterpart.
export function localWidgetToWeb(w: WidgetSpec, savedFunnels: SavedFunnel[]): { widgets: WidgetInput[]; notes: string[] } {
  const notes: string[] = [];
  if (w.filters) notes.push(`${w.name}: filters expression is not applicable to web widgets (ignored)`);

  if (w.funnel_id !== undefined) return { widgets: [{ funnel_id: w.funnel_id }], notes };

  if (w.preset) {
    const mapping: Mapping = LOCAL_TO_WEB[w.preset];
    if ("funnels" in mapping) {
      if (savedFunnels.length === 0) throw new Error("no saved funnels in this app");
      return { widgets: savedFunnels.map((f) => ({ funnel_id: f.id })), notes };
    }
    if ("presets" in mapping) {
      if (w.segment_id !== undefined) notes.push(`${w.name}: segment_id is not applied to web preset widgets`);
      return { widgets: mapping.presets.map((preset) => ({ preset })), notes };
    }
    return {
      widgets: [{ name: w.name, ...mapping.custom, segment_id: w.segment_id }],
      notes,
    };
  }

  return {
    widgets: [{ name: w.name, metrics: w.metrics, dimensions: w.dimensions, segment_id: w.segment_id }],
    notes,
  };
}
