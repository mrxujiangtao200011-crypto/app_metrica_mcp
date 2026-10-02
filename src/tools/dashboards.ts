import { z } from "zod";
import type { AppMetricaClient } from "../client.js";
import type { Config } from "../config.js";
import type { ServerAdapter } from "../server.js";
import {
  DEFAULT_PRESETS,
  PRESET_NAMES,
  describePresets,
  type PresetName,
  runDashboard,
  validateWidgetSpec,
  widgetSpecSchema,
  type WidgetSpec,
} from "../dashboards.js";
import { deleteWorkspace, getWorkspace, listWorkspaces, saveWorkspace } from "../workspaces.js";
import { ok, err } from "../util.js";

export function registerDashboardTools(server: ServerAdapter, client: AppMetricaClient, config: Config): void {
  server.tool(
    "get_dashboard",
    `Dashboard: a set of widgets computed from the public Reporting API, similar to the AppMetrica web "Обзор". The web workspaces/dashboards themselves are NOT accessible via the public API (internal cookie-auth endpoint), so dashboards are composed from presets or from a locally saved workspace (save_workspace).
Presets: ${PRESET_NAMES.join(", ")}. Default set: ${DEFAULT_PRESETS.join(", ")}. See list_dashboard_presets for the metrics of each preset.
Pass either widgets (preset names) or workspace (name of a locally saved workspace, which defines the widgets and may define a default app_id) — not both. With neither, the default set is used.
Each widget costs one Reporting API request, run sequentially (quota: 30 requests/second, 5000/day); the 'funnels' preset costs one request per saved funnel. A failing widget returns {name, error} and does not fail the whole dashboard. Namespaces are never mixed within a request.
group (day|week|month) turns widgets without breakdown into time series (no period-wide total then). segment_id (list_segments) is ANDed with each widget's own filters/segment. currency (default USD) applies to revenue widgets.`,
    {
      app_id: z.number().optional().describe("AppMetrica application ID (optional only when the workspace defines app_id)"),
      date_from: z.string().describe("Start date in YYYY-MM-DD format"),
      date_to: z.string().describe("End date in YYYY-MM-DD format"),
      widgets: z.array(z.enum(PRESET_NAMES)).optional().describe("Preset widget names"),
      workspace: z.string().optional().describe("Name of a saved local workspace"),
      group: z.enum(["day", "week", "month"]).optional().describe("Time bucket for widgets without breakdown"),
      currency: z.enum(["RUB", "USD", "EUR", "YND"]).optional().default("USD").describe("Currency for revenue widgets (default USD)"),
      segment_id: z.number().optional().describe("Saved segment ID applied to all widgets"),
    },
    async (args) => {
      try {
        const a = args as {
          app_id?: number;
          date_from: string;
          date_to: string;
          widgets?: PresetName[];
          workspace?: string;
          group?: "day" | "week" | "month";
          currency?: string;
          segment_id?: number;
        };

        if (a.widgets && a.workspace) return err("Specify either widgets or workspace, not both");

        let appId = a.app_id;
        let specs: WidgetSpec[];
        if (a.workspace) {
          const ws = await getWorkspace(config.workspacesFile, a.workspace);
          appId ??= ws.app_id;
          specs = ws.widgets;
        } else {
          specs = (a.widgets ?? DEFAULT_PRESETS).map((preset) => ({ name: preset, preset }));
        }
        if (appId === undefined) return err("app_id is required (the workspace does not define a default app_id)");

        const result = await runDashboard(client, {
          appId,
          dateFrom: a.date_from,
          dateTo: a.date_to,
          widgets: specs,
          group: a.group,
          currency: a.currency ?? "USD",
          segmentId: a.segment_id,
        });
        return ok(result);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_dashboard_presets",
    "List the preset dashboard widgets usable in get_dashboard / save_workspace: name, title, namespace, metrics, breakdown dimensions, limit, whether a currency is needed, and the default set.",
    {},
    async () => ok({ default: DEFAULT_PRESETS, presets: describePresets() })
  );

  server.tool(
    "list_workspaces",
    `List locally saved workspaces (named widget sets) from ${config.workspacesFile} (override with APPMETRICA_WORKSPACES_FILE). These are the MCP's own local workspaces — AppMetrica web workspaces are not exposed by the public API.`,
    {},
    async () => {
      try {
        const workspaces = await listWorkspaces(config.workspacesFile);
        return ok({
          file: config.workspacesFile,
          workspaces: Object.entries(workspaces).map(([name, ws]) => ({
            name,
            app_id: ws.app_id,
            description: ws.description,
            widgets: ws.widgets.map((w) => w.name),
            updated_at: ws.updated_at,
          })),
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_workspace",
    "Get a locally saved workspace with its full widget specs.",
    {
      name: z.string().describe("Workspace name"),
    },
    async (args) => {
      try {
        const { name } = args as { name: string };
        const ws = await getWorkspace(config.workspacesFile, name);
        return ok({ name, ...ws });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "save_workspace",
    `Create or update (upsert) a local workspace: a named set of dashboard widgets stored in ${config.workspacesFile}. Local file operation only — nothing is written to AppMetrica, so it is not gated by APPMETRICA_ALLOW_WRITE.
Each widget has a name and exactly one of: preset (${PRESET_NAMES.join(", ")}), metrics (custom, single namespace; optional dimensions/filters/segment_id/limit) or funnel_id (saved funnel). Use it later via get_dashboard(workspace=name).`,
    {
      name: z.string().min(1).describe("Workspace name"),
      widgets: z.array(widgetSpecSchema).min(1).describe("Widget specs"),
      app_id: z.number().optional().describe("Default app_id for get_dashboard(workspace=...)"),
      description: z.string().optional().describe("Free-text description"),
    },
    async (args) => {
      try {
        const { name, widgets, app_id, description } = args as {
          name: string;
          widgets: WidgetSpec[];
          app_id?: number;
          description?: string;
        };
        widgets.forEach(validateWidgetSpec);
        const ws = await saveWorkspace(config.workspacesFile, name, { widgets, app_id, description });
        return ok({ name, ...ws });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_workspace",
    "Delete a local workspace by name (local file operation only; nothing is changed in AppMetrica).",
    {
      name: z.string().describe("Workspace name"),
    },
    async (args) => {
      try {
        const { name } = args as { name: string };
        await deleteWorkspace(config.workspacesFile, name);
        return ok({ deleted: name });
      } catch (e) {
        return err(e);
      }
    }
  );
}
