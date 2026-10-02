import { z } from "zod";
import type { AppMetricaClient } from "../client.js";
import type { ServerAdapter } from "../server.js";
import { ok, err } from "../util.js";

export function registerManagementTools(server: ServerAdapter, client: AppMetricaClient): void {
  server.tool(
    "list_applications",
    "List all AppMetrica applications available to the authenticated user. Returns application IDs, names, platforms, and creation dates.",
    {},
    async () => {
      try {
        const data = await client.get<{
          applications: Array<{
            id: number;
            name: string;
            platform: string;
            created_at: string;
          }>;
        }>("/management/v1/applications");

        const apps = data.applications.map((app) => ({
          id: app.id,
          name: app.name,
          platform: app.platform,
          created_at: app.created_at,
        }));

        return ok(apps);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_application",
    "Get detailed information about a specific AppMetrica application by its ID.",
    {
      app_id: z.number().describe("AppMetrica application ID"),
    },
    async (args) => {
      try {
        const { app_id } = args as { app_id: number };
        const data = await client.get<unknown>(`/management/v1/applications/${app_id}`);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_events",
    "List the client event names reported by an AppMetrica application (Management API \"events list\"). Use these names as steps in get_funnel_report or as eventLabel filters.",
    {
      app_id: z.number().describe("AppMetrica application ID"),
    },
    async (args) => {
      try {
        const { app_id } = args as { app_id: number };
        const data = await client.get<{ events_info?: { events?: string[] } }>("/v1/traffic/sources/events", {
          appId: app_id,
        });
        const events = data.events_info?.events ?? [];
        return ok({ count: events.length, events });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_conversions",
    "List conversions (attributed-event definitions) configured for an AppMetrica application: id, name, event_type, attribution_rule, status, mandatory, etc. Conversion metrics are in the ym:ae2:* namespace.",
    {
      app_id: z.number().describe("AppMetrica application ID"),
    },
    async (args) => {
      try {
        const { app_id } = args as { app_id: number };
        const data = await client.get<{ response?: { conversions?: unknown[] } }>(
          `/management/v1/application/${app_id}/conversions`
        );
        return ok(data.response?.conversions ?? []);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_logs_api_status",
    "Check whether the Logs API is enabled for the account (\"enabled\" / \"disabled\"). When it is disabled, export_events / export_logs keep returning 202 (queued) or 429 — this is how to find out why.",
    {},
    async () => {
      try {
        const data = await client.get<{ logs_api_availability_status?: string }>("/management/v1/logsapi/status");
        return ok(data);
      } catch (e) {
        return err(e);
      }
    }
  );
}
