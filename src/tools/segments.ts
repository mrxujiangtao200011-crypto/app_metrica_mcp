import { z } from "zod";
import type { AppMetricaClient } from "../client.js";
import type { Config } from "../config.js";
import type { ServerAdapter } from "../server.js";
import {
  createSegment,
  deleteSegment,
  getSegment,
  segmentFromEvents,
  updateSegment,
  type Segment,
} from "../segments.js";
import { ok, err, writeDisabled } from "../util.js";

function segmentSummary(segment: Segment): Record<string, unknown> {
  return {
    segment_id: segment.segment_id,
    name: segment.name,
    expression: segment.expression,
    edit_access: segment.edit_access,
  };
}

export function registerSegmentTools(server: ServerAdapter, client: AppMetricaClient, config: Config): void {
  server.tool(
    "list_segments",
    "List saved segments of an AppMetrica application (the segments from the web UI). Returns segment_id, name, expression and edit_access. Pass segment_id to get_report / get_report_bytime / get_funnel_report / get_dashboard to restrict the report to a segment (its expression is ANDed into filters).",
    {
      app_id: z.number().describe("AppMetrica application ID"),
    },
    async (args) => {
      try {
        const { app_id } = args as { app_id: number };
        const data = await client.get<{
          segments?: Array<{ segment_id: number; name: string; expression: string; edit_access: boolean }>;
        }>(`/management/v1/application/${app_id}/segments`);

        return ok(
          (data.segments ?? []).map((s) => ({
            segment_id: s.segment_id,
            name: s.name,
            expression: s.expression,
            edit_access: s.edit_access,
          }))
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_segment",
    "Get a saved segment of an AppMetrica application with all fields (segment_id, api_key, name, params, expression, owner, edit_access).",
    {
      app_id: z.number().describe("AppMetrica application ID"),
      segment_id: z.number().describe("Segment ID from list_segments"),
    },
    async (args) => {
      try {
        const { app_id, segment_id } = args as { app_id: number; segment_id: number };
        const data = await client.get<{ segment?: unknown }>(
          `/management/v1/application/${app_id}/segment/${segment_id}`
        );
        return ok(data.segment ?? data);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "create_segment",
    `Create a saved segment in AppMetrica (shown in the web UI; pass its segment_id to get_report / get_report_bytime / get_funnel_report / get_dashboard). Requires APPMETRICA_ALLOW_WRITE=true.
Condition: events — users who did ALL the listed client events (expression "exists ym:ce:device with (eventLabel=='X')" AND-joined; editable in the web segment editor). The API derives the expression from the editor filter JSON, so other condition types (device, geo, version, profile…) must be created in the web UI; for ad-hoc filtering use the filters parameter of the report tools instead.
Returns {segment_id, name, expression, edit_access}.`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      name: z.string().describe("Segment name"),
      events: z.array(z.string()).min(1).describe("Client event names; users who did all of them (list_events)"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();

      try {
        const a = args as { app_id: number; name: string; events: string[] };
        const segment = await createSegment(client, a.app_id, { name: a.name, ...segmentFromEvents(a.events) });
        return ok(segmentSummary(segment));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "update_segment",
    `Update a saved segment in AppMetrica: fetches the segment, merges the given fields and saves it. Requires APPMETRICA_ALLOW_WRITE=true.
Give name and/or events (new condition: users who did all listed client events). Omitted fields keep their saved values.
Returns {segment_id, name, expression, edit_access}.`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      segment_id: z.number().describe("Segment ID from list_segments"),
      name: z.string().optional().describe("New segment name"),
      events: z.array(z.string()).min(1).optional().describe("New condition: users who did all these client events"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();

      try {
        const a = args as { app_id: number; segment_id: number; name?: string; events?: string[] };
        if (a.name === undefined && a.events === undefined) return err("Nothing to update");

        const existing = await getSegment(client, a.app_id, a.segment_id);
        // The API rebuilds `expression` from `params`; saving without them would wipe the condition.
        const existingParams =
          typeof existing.params === "string"
            ? existing.params
            : existing.params && typeof existing.params === "object"
              ? JSON.stringify(existing.params)
              : "";
        if (a.events === undefined && !existingParams) {
          return err(`Segment ${a.segment_id} has no editor params — pass events to rename it safely`);
        }
        const built = a.events !== undefined ? segmentFromEvents(a.events) : { expression: existing.expression, params: existingParams };
        const segment = await updateSegment(client, a.app_id, a.segment_id, { name: a.name ?? existing.name, ...built });
        return ok(segmentSummary(segment));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_segment",
    "Delete a saved segment from AppMetrica (irreversible; reports and dashboards using its segment_id will fail). Requires APPMETRICA_ALLOW_WRITE=true.",
    {
      app_id: z.number().describe("AppMetrica application ID"),
      segment_id: z.number().describe("Segment ID from list_segments"),
    },
    async (args) => {
      if (!config.allowWrite) return writeDisabled();

      try {
        const { app_id, segment_id } = args as { app_id: number; segment_id: number };
        const data = await deleteSegment(client, app_id, segment_id);
        return ok({ segment_id, response: data });
      } catch (e) {
        return err(e);
      }
    }
  );
}
