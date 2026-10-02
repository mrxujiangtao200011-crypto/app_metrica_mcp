import { z } from "zod";
import type { AppMetricaClient } from "../client.js";
import type { Config } from "../config.js";
import type { ServerAdapter } from "../server.js";
import {
  buildSavedFunnelBody,
  createFunnel,
  deleteFunnel,
  listSavedFunnels,
  parseFrontendPattern,
  runFunnelReport,
  stepsFromFrontendPattern,
  updateFunnel,
  type FunnelStepInput,
  type SavedFunnel,
  type SavedFunnelBody,
} from "../funnels.js";
import { combineFilters, resolveSegmentExpression } from "../segments.js";
import { ok, err, writeDisabled } from "../util.js";

const stepSchema = z.object({
  title: z.string().optional().describe("Step title (default: event names / kind)"),
  kind: z
    .enum(["client_events", "install", "session_start", "crash", "error", "purchase", "ad_revenue", "deeplink", "any_event"])
    .optional()
    .describe("Step kind (default client_events, which requires events)"),
  events: z.array(z.string()).optional().describe("Client event names; several names = any of them (OR). Required for kind client_events"),
  event_params: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional()
    .describe("Event parameter conditions (key == value), all must match"),
});

// Compact view of a funnel returned by create_funnel / update_funnel.
function funnelSummary(funnel: SavedFunnel | undefined, body: SavedFunnelBody): Record<string, unknown> {
  return {
    id: funnel?.id,
    name: funnel?.name ?? body.name,
    steps: parseFrontendPattern(funnel?.frontend_pattern ?? body.frontend_pattern).steps.map((s) => s.title),
    pattern: funnel?.pattern ?? body.pattern,
  };
}

export function registerFunnelTools(server: ServerAdapter, client: AppMetricaClient, config: Config): void {
  server.tool(
    "list_funnels",
    "List saved funnels of an AppMetrica application (funnel reports from the web UI): id, name, comment, decoded steps (title, events, kind), single_session, events_between_steps, grouping and the raw API pattern. Pass funnel_id to get_funnel_report to compute a saved funnel.",
    {
      app_id: z.number().describe("AppMetrica application ID"),
    },
    async (args) => {
      try {
        const { app_id } = args as { app_id: number };
        const funnels = await listSavedFunnels(client, app_id);
        return ok(
          funnels.map((f) => {
            const parsed = parseFrontendPattern(f.frontend_pattern ?? "");
            return {
              id: f.id,
              name: f.name,
              comment: f.comment,
              steps: parsed.steps,
              single_session: parsed.singleSession,
              events_between_steps: parsed.eventsBetweenSteps,
              grouping: parsed.grouping,
              pattern: f.pattern,
            };
          })
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_funnel_report",
    `Funnel report — the web "Funnels" report via the Reporting API: devices reaching each step in sequence, with absolute (% of step 1) and relative (% of previous step) conversion.
Provide exactly one of: funnel_id (saved funnel from list_funnels — its pattern is used verbatim and the options below are ignored) or steps (ad-hoc funnel, e.g. [{"events":["app_open"]},{"events":["purchase"]}]; event names from list_events).
Ad-hoc options: foreground_only (default true, count only foreground sessions), single_session (default false; true = all steps within one session), events_between_steps (default true; false = steps must follow each other directly). window_seconds limits the time from first to last step.
Under the hood: ym:uf:devicesInStepN (ym:sf: for single-session) with funnel_pattern / funnel_restriction params, one request. dimensions break the funnel down (full keys or bare suffixes such as 'date', 'appVersion', 'operatingSystemInfo', 'regionCountry'); group (day|week|month) adds a time series via one extra /bytime request.
filters / segment_id restrict the audience (segment expression is ANDed with filters).`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      date_from: z.string().describe("Start date in YYYY-MM-DD format"),
      date_to: z.string().describe("End date in YYYY-MM-DD format"),
      funnel_id: z.number().optional().describe("Saved funnel ID (list_funnels)"),
      steps: z.array(stepSchema).optional().describe("Ad-hoc funnel steps"),
      foreground_only: z.boolean().optional().default(true).describe("Ad-hoc: count only foreground sessions (default true)"),
      single_session: z.boolean().optional().default(false).describe("Ad-hoc: all steps within one session (default false)"),
      events_between_steps: z.boolean().optional().default(true).describe("Ad-hoc: allow other events between steps (default true)"),
      window_seconds: z.number().int().positive().optional().describe("Max seconds from first to last step"),
      dimensions: z.array(z.string()).optional().describe("Breakdown dimensions, full keys or bare suffixes (prefixed with ym:uf:/ym:sf:)"),
      filters: z.string().optional().describe("Segmentation filter expression"),
      segment_id: z.number().optional().describe("Saved segment ID (list_segments); ANDed with filters"),
      group: z.enum(["day", "week", "month"]).optional().describe("Add a per-interval series (extra bytime request)"),
      limit: z.number().optional().default(50).describe("Max dimension rows (default 50)"),
    },
    async (args) => {
      try {
        const a = args as {
          app_id: number;
          date_from: string;
          date_to: string;
          funnel_id?: number;
          steps?: FunnelStepInput[];
          foreground_only?: boolean;
          single_session?: boolean;
          events_between_steps?: boolean;
          window_seconds?: number;
          dimensions?: string[];
          filters?: string;
          segment_id?: number;
          group?: "day" | "week" | "month";
          limit?: number;
        };

        if ((a.funnel_id === undefined) === (a.steps === undefined)) {
          return err("Specify exactly one of funnel_id or steps");
        }

        let funnel;
        if (a.funnel_id !== undefined) {
          const saved = await listSavedFunnels(client, a.app_id);
          funnel = saved.find((f) => f.id === a.funnel_id);
          if (!funnel) {
            return err(
              `Funnel ${a.funnel_id} not found. Available: ${saved.map((f) => `${f.id} (${f.name})`).join(", ") || "none"}`
            );
          }
        }

        const segmentExpr =
          a.segment_id !== undefined ? await resolveSegmentExpression(client, a.app_id, a.segment_id) : undefined;

        const result = await runFunnelReport(client, {
          appId: a.app_id,
          dateFrom: a.date_from,
          dateTo: a.date_to,
          funnel,
          steps: a.steps,
          foregroundOnly: a.foreground_only,
          singleSession: a.single_session,
          eventsBetweenSteps: a.events_between_steps,
          windowSeconds: a.window_seconds,
          dimensions: a.dimensions,
          filters: combineFilters(segmentExpr, a.filters),
          group: a.group,
          limit: a.limit,
        });
        return ok(result);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "create_funnel",
    `Create a saved funnel in AppMetrica (visible in the web "Funnels" report and in list_funnels). Requires APPMETRICA_ALLOW_WRITE=true.
Verify the steps with get_funnel_report(steps=...) first. Steps must be representable in the web funnel editor: client events (several names = any of them; at most ONE event_params entry per step, applied to every event of the step) or kind "install". Other step kinds (crash, purchase, session_start, ...) are rejected — use get_funnel_report for those ad-hoc.
Options: foreground_only (default true), single_session (default false), events_between_steps (default true; false is saved as a "next"-joined pattern without funnel_restriction, which the API does not store — unverified, prefer the default).
Returns {id, name, steps, pattern, next}.`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      name: z.string().describe("Funnel name"),
      steps: z.array(stepSchema).min(1).describe("Funnel steps, e.g. [{\"events\":[\"app_open\"]},{\"events\":[\"purchase\"]}] (event names from list_events)"),
      comment: z.string().optional().describe("Funnel comment"),
      foreground_only: z.boolean().optional().default(true).describe("Count only foreground sessions (default true)"),
      single_session: z.boolean().optional().default(false).describe("All steps within one session (default false)"),
      events_between_steps: z.boolean().optional().default(true).describe("Allow other events between steps (default true)"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();

      try {
        const a = args as {
          app_id: number;
          name: string;
          steps: FunnelStepInput[];
          comment?: string;
          foreground_only?: boolean;
          single_session?: boolean;
          events_between_steps?: boolean;
        };
        const body = buildSavedFunnelBody(a.name, a.comment ?? "", a.steps, {
          foregroundOnly: a.foreground_only ?? true,
          singleSession: a.single_session ?? false,
          eventsBetweenSteps: a.events_between_steps ?? true,
        });
        const funnel = await createFunnel(client, a.app_id, body);
        return ok({ ...funnelSummary(funnel, body), next: "verify with get_funnel_report(funnel_id)" });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "update_funnel",
    `Update a saved funnel in AppMetrica. Requires APPMETRICA_ALLOW_WRITE=true.
Only name/comment given: the saved pattern is kept verbatim. If steps or any of foreground_only / single_session / events_between_steps is given, pattern and frontend_pattern are rebuilt from the existing steps (or the new steps) merged with the given options; steps the web editor cannot represent are rejected (see create_funnel).
Returns {id, name, steps, pattern, next}.`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      funnel_id: z.number().describe("Funnel ID from list_funnels"),
      name: z.string().optional().describe("New funnel name"),
      comment: z.string().optional().describe("New funnel comment"),
      steps: z.array(stepSchema).min(1).optional().describe("New funnel steps (replace all existing steps)"),
      foreground_only: z.boolean().optional().describe("Count only foreground sessions"),
      single_session: z.boolean().optional().describe("All steps within one session"),
      events_between_steps: z.boolean().optional().describe("Allow other events between steps"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();

      try {
        const a = args as {
          app_id: number;
          funnel_id: number;
          name?: string;
          comment?: string;
          steps?: FunnelStepInput[];
          foreground_only?: boolean;
          single_session?: boolean;
          events_between_steps?: boolean;
        };
        const rebuild =
          a.steps !== undefined ||
          a.foreground_only !== undefined ||
          a.single_session !== undefined ||
          a.events_between_steps !== undefined;
        if (a.name === undefined && a.comment === undefined && !rebuild) return err("Nothing to update");

        const saved = await listSavedFunnels(client, a.app_id);
        const funnel = saved.find((f) => f.id === a.funnel_id);
        if (!funnel) {
          return err(
            `Funnel ${a.funnel_id} not found. Available: ${saved.map((f) => `${f.id} (${f.name})`).join(", ") || "none"}`
          );
        }

        let pattern = funnel.pattern;
        let frontendPattern = funnel.frontend_pattern;
        if (rebuild) {
          const existing = parseFrontendPattern(funnel.frontend_pattern ?? "");
          const rebuilt = buildSavedFunnelBody(
            funnel.name,
            funnel.comment ?? "",
            a.steps ?? stepsFromFrontendPattern(funnel.frontend_pattern ?? ""),
            {
              foregroundOnly: a.foreground_only ?? existing.grouping === "users",
              singleSession: a.single_session ?? existing.singleSession,
              eventsBetweenSteps: a.events_between_steps ?? existing.eventsBetweenSteps,
            }
          );
          pattern = rebuilt.pattern;
          frontendPattern = rebuilt.frontend_pattern;
        }
        if (!frontendPattern) return err(`Funnel ${a.funnel_id} has no frontend_pattern; pass steps to rebuild it`);

        const body: SavedFunnelBody = {
          name: a.name ?? funnel.name,
          comment: a.comment ?? funnel.comment ?? "",
          pattern_type: funnel.pattern_type ?? "user",
          pattern,
          frontend_pattern: frontendPattern,
        };
        const updated = await updateFunnel(client, a.app_id, a.funnel_id, body);
        return ok({ ...funnelSummary(updated, body), next: "verify with get_funnel_report(funnel_id)" });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_funnel",
    "Delete a saved funnel from AppMetrica (irreversible). Requires APPMETRICA_ALLOW_WRITE=true.",
    {
      app_id: z.number().describe("AppMetrica application ID"),
      funnel_id: z.number().describe("Funnel ID from list_funnels"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();

      try {
        const { app_id, funnel_id } = args as { app_id: number; funnel_id: number };
        const data = await deleteFunnel(client, app_id, funnel_id);
        return ok({ funnel_id, response: data });
      } catch (e) {
        return err(e);
      }
    }
  );
}
