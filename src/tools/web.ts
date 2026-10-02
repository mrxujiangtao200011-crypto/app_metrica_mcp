import { z } from "zod";
import type { AppMetricaClient } from "../client.js";
import type { Config } from "../config.js";
import type { ServerAdapter, ToolResult } from "../server.js";
import { listSavedFunnels } from "../funnels.js";
import { getWorkspace as getLocalWorkspace } from "../workspaces.js";
import { err, ok, writeDisabled } from "../util.js";
import { NotLoggedInError } from "../web/session.js";
import {
  addHeader,
  addWidgetGroup,
  createDashboard,
  dashboardUrl,
  describeGroups,
  getDashboard,
  getNamespace,
  listDashboards,
  listNamespaces,
  listWidgets,
  localWidgetToWeb,
  newNormalizeCache,
  normalizeGroups,
  removeDashboard,
  removeWidget,
  renameDashboard,
  summarizeDashboard,
  webSession,
  type GroupInput,
  type WidgetInput,
} from "../web/dashboards.js";

const TAG = "[Experimental web session]";
const LOGIN = "Uses the unofficial AppMetrica web API through a headless Chrome session: run `npx appmetrica-mcp login` once to log in to Yandex.";
const WRITE = "Requires APPMETRICA_ALLOW_WRITE=true.";
const NOT_LOGGED_IN =
  "AppMetrica web session is not logged in. Run `npx appmetrica-mcp login` in a terminal (opens Chrome; log in to Yandex once), then retry.";
const SYSTEM_DASHBOARD = /^\d+\//;

function webErr(e: unknown): ToolResult {
  if (e instanceof NotLoggedInError) return { isError: true, content: [{ type: "text", text: NOT_LOGGED_IN }] };
  return err(e);
}

const widgetInputSchema = z.object({
  preset: z.string().optional().describe("Web preset widget id, e.g. AudienceMulti, Installs, CrashFreeSessions (web_list_widget_presets)"),
  funnel_id: z.number().optional().describe("Saved funnel ID (list_funnels): creates a Funnels widget bound to that funnel"),
  name: z.string().optional().describe("Custom widget title (default: the first metric's title)"),
  namespace: z
    .string()
    .optional()
    .describe("Custom widget: report namespace id (web_list_report_namespaces); derived from the first metric's ym:*: prefix when omitted"),
  metrics: z.array(z.string()).optional().describe("Custom widget: metric ids of one namespace, e.g. ym:u:users"),
  dimensions: z.array(z.string()).optional().describe("Custom widget: dimension ids (full keys or bare suffixes of the namespace)"),
  segment_id: z.number().optional().describe("Custom widget: saved segment ID (list_segments)"),
  view_kind: z
    .string()
    .optional()
    .describe("Timeline (default), TimeColumn, Table, Pie, MultiTimeColumn, FunnelFirstStep (funnels default); other values are passed through"),
});

const WIDGET_HELP =
  "A widget is exactly one of: preset (web preset id), funnel_id (saved funnel), or metrics (custom widget: namespace derived from the metric prefix, metric/dimension ids validated against the namespace).";

const groupSchema = z.object({
  header: z.string().optional().describe("Section header text"),
  widgets: z.array(widgetInputSchema).optional().describe("Widgets shown side by side in one row"),
});

export function registerWebTools(server: ServerAdapter, client: AppMetricaClient, config: Config): void {
  server.tool(
    "web_session_status",
    `${TAG} Check the AppMetrica web session (Chrome profile with a Yandex login) used by the web_* tools: logged_in, Yandex login, profile directory. Starts headless Chrome on first use (about 7 seconds). ${LOGIN}`,
    {},
    async () => {
      try {
        return ok(await webSession().status());
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_list_workspaces",
    `${TAG} List the app's AppMetrica web workspaces (dashboards): system ones (id "<appId>/General" = Overview, "<appId>/Audience", ...) and custom ones. Returns dashboard_id, name, is_system, preset_kind, number of groups and widgets. ${LOGIN}`,
    { app_id: z.number().describe("AppMetrica application ID") },
    async (args) => {
      try {
        const { app_id } = args as { app_id: number };
        return ok((await listDashboards(app_id)).map(summarizeDashboard));
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_get_workspace",
    `${TAG} Get one AppMetrica web workspace: groups with headers and widgets (dashboard_widget_id, widget_id, view kind, funnel_id), enriched with the widget name, namespace, metrics and dimensions. ${LOGIN}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      dashboard_id: z.string().describe("Dashboard ID from web_list_workspaces"),
    },
    async (args) => {
      try {
        const { app_id, dashboard_id } = args as { app_id: number; dashboard_id: string };
        const dashboard = await getDashboard(app_id, dashboard_id);
        if (!dashboard) return err(`Workspace "${dashboard_id}" not found for app ${app_id}`);
        const widgets = await listWidgets(app_id);
        return ok({
          dashboard_id: dashboard.dashboardId,
          name: dashboard.name,
          is_system: Boolean(dashboard.isSystem),
          is_editable: dashboard.isEditable ?? undefined,
          url: dashboardUrl(app_id, dashboard.dashboardId),
          groups: describeGroups(dashboard, widgets),
        });
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_list_widget_presets",
    `${TAG} List the web preset widgets usable in web_create_workspace / web_add_widgets (widget_id is the \`preset\` value): name, namespace, categories, metrics, dimensions, default view kind. ${LOGIN}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      category: z.string().optional().describe("Only presets of this category, e.g. Product"),
    },
    async (args) => {
      try {
        const { app_id, category } = args as { app_id: number; category?: string };
        const wanted = category?.toLowerCase();
        const presets = (await listWidgets(app_id)).filter(
          (w) => w.categoryIds && (!wanted || w.categoryIds.some((c) => c.toLowerCase() === wanted))
        );
        return ok(
          presets.map((w) => ({
            widget_id: w.widgetId,
            name: w.name,
            namespace: w.namespace,
            categories: w.categoryIds,
            metrics: w.metrics?.map((m) => m.id),
            dimensions: w.dimensions?.map((d) => d.id),
            default_view_kind: w.defaultViewKind ?? undefined,
          }))
        );
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_list_report_namespaces",
    `${TAG} List report namespaces of the web constructor (id, name, Reporting API prefix, e.g. Audience = ym:u:). With namespace_id: the metrics and dimensions (id, title; first 200 each) valid for custom widgets of that namespace. ${LOGIN}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      namespace_id: z.string().optional().describe("Namespace id, e.g. Audience, Revenue, Events"),
    },
    async (args) => {
      try {
        const { app_id, namespace_id } = args as { app_id: number; namespace_id?: string };
        if (!namespace_id) {
          return ok((await listNamespaces(app_id)).map((n) => ({ id: n.id, name: n.name, api_prefix: n.apiTableId })));
        }
        const ns = await getNamespace(app_id, namespace_id);
        const cap = 200;
        const pick = (list?: Array<{ id: string; title?: string | null }> | null) => (list ?? []).slice(0, cap).map((x) => ({ id: x.id, title: x.title }));
        return ok({
          id: ns.id,
          name: ns.name,
          api_prefix: ns.apiTableId,
          metrics: pick(ns.metrics),
          dimensions: pick(ns.dimensions),
          total_metrics: ns.metrics?.length ?? 0,
          total_dimensions: ns.dimensions?.length ?? 0,
        });
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_create_workspace",
    `${TAG} Create a workspace (dashboard) in AppMetrica itself in one call. groups is an ordered list of rows; a group is {header?: string, widgets?: WidgetInput[]} (header and widgets in one group become a header row followed by a widgets row). ${WIDGET_HELP} Limits: 20 dashboards per app, 20 widgets and 40 groups per dashboard. Returns {dashboard_id, name, url, groups}. ${LOGIN} ${WRITE}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      name: z.string().min(1).describe("Workspace name"),
      groups: z.array(groupSchema).optional().describe("Initial groups (rows) of the workspace"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();
      try {
        const { app_id, name, groups } = args as { app_id: number; name: string; groups?: GroupInput[] };
        const dashboard = await createDashboard(app_id, name, groups ?? []);
        return ok({
          dashboard_id: dashboard.dashboardId,
          name: dashboard.name ?? name,
          url: dashboardUrl(app_id, dashboard.dashboardId),
          groups: describeGroups(dashboard),
        });
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_add_widgets",
    `${TAG} Add one group (a row of widgets) to an existing AppMetrica workspace. ${WIDGET_HELP} position is the 0-based index among the groups (default: append). ${LOGIN} ${WRITE}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      dashboard_id: z.string().describe("Dashboard ID from web_list_workspaces"),
      widgets: z.array(widgetInputSchema).min(1).describe("Widgets of the new row"),
      position: z.number().int().min(0).optional().describe("0-based index among groups"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();
      try {
        const a = args as { app_id: number; dashboard_id: string; widgets: WidgetInput[]; position?: number };
        const result = (await addWidgetGroup(a.app_id, a.dashboard_id, a.widgets, a.position)) as {
          dashboardId?: string;
          group?: { dashboardWidgetGroupId?: string; widgets?: Array<{ dashboardWidgetId: string; widgetId: string; viewKind: string; funnelId?: string | null }> };
          widgets?: Array<{ widgetId: string; name?: string }>;
        };
        return ok({
          dashboard_id: result.dashboardId,
          group_id: result.group?.dashboardWidgetGroupId,
          widgets: (result.group?.widgets ?? []).map((w) => ({
            dashboard_widget_id: w.dashboardWidgetId,
            widget_id: w.widgetId,
            view_kind: w.viewKind,
            funnel_id: w.funnelId ?? undefined,
            name: result.widgets?.find((x) => x.widgetId === w.widgetId)?.name,
          })),
        });
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_add_header",
    `${TAG} Add a section header row to an AppMetrica workspace. position is the 0-based index among the groups (default: append). ${LOGIN} ${WRITE}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      dashboard_id: z.string().describe("Dashboard ID from web_list_workspaces"),
      title: z.string().min(1).describe("Header text"),
      position: z.number().int().min(0).optional().describe("0-based index among groups"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();
      try {
        const a = args as { app_id: number; dashboard_id: string; title: string; position?: number };
        return ok(await addHeader(a.app_id, a.dashboard_id, a.title, a.position));
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_rename_workspace",
    `${TAG} Rename an AppMetrica workspace. ${LOGIN} ${WRITE}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      dashboard_id: z.string().describe("Dashboard ID from web_list_workspaces"),
      name: z.string().min(1).describe("New name"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();
      try {
        const a = args as { app_id: number; dashboard_id: string; name: string };
        return ok({ renamed: await renameDashboard(a.app_id, a.dashboard_id, a.name), dashboard_id: a.dashboard_id, name: a.name });
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_remove_widget",
    `${TAG} Remove one widget from an AppMetrica workspace by dashboard_widget_id (see web_get_workspace). ${LOGIN} ${WRITE}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      dashboard_id: z.string().describe("Dashboard ID from web_list_workspaces"),
      dashboard_widget_id: z.string().describe("dashboard_widget_id from web_get_workspace"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();
      try {
        const a = args as { app_id: number; dashboard_id: string; dashboard_widget_id: string };
        return ok({ removed: await removeWidget(a.app_id, a.dashboard_id, a.dashboard_widget_id), dashboard_widget_id: a.dashboard_widget_id });
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_delete_workspace",
    `${TAG} Delete a custom AppMetrica workspace. System dashboards (id like "<appId>/General") are refused. ${LOGIN} ${WRITE}`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      dashboard_id: z.string().describe("Dashboard ID from web_list_workspaces"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();
      try {
        const a = args as { app_id: number; dashboard_id: string };
        if (SYSTEM_DASHBOARD.test(a.dashboard_id)) {
          return err(`Refusing to delete the system dashboard "${a.dashboard_id}"; only custom workspaces can be deleted.`);
        }
        return ok({ deleted: await removeDashboard(a.app_id, a.dashboard_id), dashboard_id: a.dashboard_id });
      } catch (e) {
        return webErr(e);
      }
    }
  );

  server.tool(
    "web_push_workspace",
    `${TAG} Create an AppMetrica workspace from a LOCAL workspace (save_workspace / list_workspaces). Each local widget becomes a header row (its name) plus a row of web widgets. Local presets map to web presets where there is a clear counterpart (audience -> AudienceMulti, installs -> Installs, engagement -> UserTimeSpent + AvgSessionTime + UserSessionsCount, app_versions -> AppVersion, crashes -> CrashFreeSessions + Crashes, errors -> ErrorLogsIos + ErrorLogsAndroid, revenue -> RevenueTotal + RevenuePurchases, ad_revenue -> AdRevenue + AdRevenueARPU + AdRevenueECPM, traffic -> Clicks + Installs + InstallConversion, push -> PushSent + PushReceived + PushOpened, retention -> RetentionDynamics, funnels -> one Funnels widget per saved funnel); the rest (installs_by_country, events, conversions, anr, ad_revenue_by_type) and local custom metrics become custom widgets; funnel_id widgets become Funnels widgets. Widgets that cannot be created (unknown metric ids, no saved funnels) are skipped and listed in "skipped". Returns {dashboard_id, name, url, groups, skipped?, notes?}. ${LOGIN} ${WRITE}`,
    {
      app_id: z.number().describe("AppMetrica application ID to create the workspace in"),
      workspace: z.string().describe("Name of the local workspace"),
      name: z.string().min(1).optional().describe("Name of the AppMetrica workspace (default: the local workspace name)"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();
      try {
        const a = args as { app_id: number; workspace: string; name?: string };
        const local = await getLocalWorkspace(config.workspacesFile, a.workspace);
        const funnels = local.widgets.some((w) => w.preset === "funnels") ? await listSavedFunnels(client, a.app_id) : [];

        const cache = newNormalizeCache();
        const groups: GroupInput[] = [];
        const skipped: Array<{ widget: string; reason: string }> = [];
        const notes: string[] = [];
        for (const w of local.widgets) {
          try {
            const mapped = localWidgetToWeb(w, funnels);
            const group: GroupInput = { header: w.name, widgets: mapped.widgets };
            await normalizeGroups(a.app_id, [group], cache); // validate ids before anything is created
            groups.push(group);
            notes.push(...mapped.notes);
          } catch (e) {
            skipped.push({ widget: w.name, reason: e instanceof Error ? e.message : String(e) });
          }
        }
        if (groups.length === 0) {
          return err(`Nothing to push from workspace "${a.workspace}". Skipped: ${JSON.stringify(skipped)}`);
        }

        const name = a.name ?? a.workspace;
        const dashboard = await createDashboard(a.app_id, name, groups, cache);
        return ok({
          dashboard_id: dashboard.dashboardId,
          name: dashboard.name ?? name,
          url: dashboardUrl(a.app_id, dashboard.dashboardId),
          groups: describeGroups(dashboard),
          skipped: skipped.length > 0 ? skipped : undefined,
          notes: notes.length > 0 ? notes : undefined,
        });
      } catch (e) {
        return webErr(e);
      }
    }
  );
}
