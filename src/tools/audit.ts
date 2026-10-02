import { z } from "zod";
import type { AppMetricaClient } from "../client.js";
import type { ServerAdapter } from "../server.js";
import { dimensionLabel } from "../funnels.js";
import { ok, err, type ReportResponse } from "../util.js";

type AuditEvent = {
  name: string;
  events: number;
  devices: number;
  status: "active" | "zero_volume" | "missing";
  expected?: boolean;
};

const FLOW_CHECKS: Array<{ re: RegExp; label: string; funnel: string }> = [
  { re: /first.?launch|install|onboard/i, label: "first-launch / onboarding", funnel: "onboarding" },
  { re: /regist|signup|sign_up|login/i, label: "registration / login", funnel: "registration" },
  { re: /purchase|subscri|payment|revenue|checkout/i, label: "purchase / subscription", funnel: "purchase" },
];

const isSystem = (name: string): boolean => name.startsWith("appmetrica_") || name.startsWith("com.yandex.");

function sample(names: string[], max = 10): string {
  return names.length > max ? `${names.slice(0, max).join(", ")} (+${names.length - max} more)` : names.join(", ");
}

export function registerAuditTools(server: ServerAdapter, client: AppMetricaClient): void {
  server.tool(
    "audit_events",
    `Audit the client-event instrumentation of an application (read-only): compares event names registered in AppMetrica (list_events) with event volumes of a period (ym:ce:allEvents / ym:ce:devices by ym:ce:eventLabel).
Each event is classified as active (has data in the period), zero_volume (registered but no data in the period) or missing (in expected_events but neither registered nor active). With expected_events (e.g. names found in the app's source code) every event carries expected=true/false, so active events with expected=false are the unexpected ones.
System events (appmetrica_*, com.yandex.*) are listed separately in system_events and excluded from the counts. findings are plain-language heuristics: missing / zero-volume / low-volume (<=5 devices) events, mixed snake_case and CamelCase naming, and no event resembling first launch / onboarding, registration or purchase.
Two requests: /v1/traffic/sources/events and /stat/v1/data.`,
    {
      app_id: z.number().describe("AppMetrica application ID"),
      date_from: z.string().describe("Start date in YYYY-MM-DD format"),
      date_to: z.string().describe("End date in YYYY-MM-DD format"),
      expected_events: z.array(z.string()).optional().describe("Event names the app is expected to report (e.g. collected from source code)"),
      limit: z.number().optional().default(500).describe("Max events requested from the report, by volume (default 500)"),
    },
    async (args) => {
      try {
        const a = args as {
          app_id: number;
          date_from: string;
          date_to: string;
          expected_events?: string[];
          limit?: number;
        };
        const limit = a.limit ?? 500;

        const list = await client.get<{ events_info?: { events?: string[] } }>("/v1/traffic/sources/events", {
          appId: a.app_id,
        });
        const registered = list.events_info?.events ?? [];

        const report = await client.get<ReportResponse>("/stat/v1/data", {
          id: a.app_id,
          metrics: "ym:ce:allEvents,ym:ce:devices",
          dimensions: "ym:ce:eventLabel",
          sort: "-ym:ce:allEvents",
          date1: a.date_from,
          date2: a.date_to,
          limit,
        });
        const rows = report.data ?? [];

        const volume = new Map<string, { events: number; devices: number }>();
        for (const row of rows) {
          const name = String(dimensionLabel(row.dimensions?.[0] ?? {}));
          volume.set(name, { events: Number(row.metrics?.[0] ?? 0), devices: Number(row.metrics?.[1] ?? 0) });
        }

        const expected = a.expected_events ? new Set(a.expected_events) : undefined;
        const mark = (name: string): { expected?: boolean } => (expected ? { expected: expected.has(name) } : {});

        const allNames = [...new Set([...registered, ...volume.keys()])];
        const systemEvents = allNames.filter(isSystem);
        const userNames = allNames.filter((n) => !isSystem(n));

        const events: AuditEvent[] = [];
        for (const [name, v] of volume) {
          if (!isSystem(name)) events.push({ name, ...v, status: "active", ...mark(name) });
        }
        const zeroVolume = userNames.filter((n) => !volume.has(n));
        for (const name of zeroVolume) events.push({ name, events: 0, devices: 0, status: "zero_volume", ...mark(name) });
        const expectedMissing = [...(expected ?? [])].filter((n) => !registered.includes(n) && !volume.has(n));
        for (const name of expectedMissing) events.push({ name, events: 0, devices: 0, status: "missing", expected: true });

        const active = events.filter((e) => e.status === "active");

        const findings: string[] = [];
        if (expectedMissing.length > 0) {
          findings.push(
            `${expectedMissing.length} expected event(s) are neither registered nor active in the period: ${sample(expectedMissing)} — not shipped yet, never triggered, or renamed.`
          );
        }
        if (zeroVolume.length > 0) {
          findings.push(
            `${zeroVolume.length} registered event(s) had no data in the period: ${sample(zeroVolume)} — check they are still sent, or drop them.`
          );
        }
        const lowVolume = active.filter((e) => e.devices <= 5);
        if (lowVolume.length > 0) {
          findings.push(
            `Low volume (<=5 devices): ${sample(lowVolume.map((e) => `${e.name} (${e.devices})`))} — check instrumentation or drop.`
          );
        }
        const snake = userNames.filter((n) => /^[a-z0-9]+(_[a-z0-9]+)+$/.test(n));
        const camel = userNames.filter((n) => !n.includes("_") && /[a-z]/.test(n) && /[A-Z]/.test(n));
        if (snake.length > 0 && camel.length > 0) {
          findings.push(
            `Mixed naming styles: ${snake.length} snake_case (e.g. ${sample(snake, 3)}) and ${camel.length} CamelCase (e.g. ${sample(camel, 3)}) — pick one convention.`
          );
        }
        for (const check of FLOW_CHECKS) {
          if (!userNames.some((n) => check.re.test(n))) {
            findings.push(`No ${check.label}-like event found; funnels for ${check.funnel} will need one.`);
          }
        }
        if (rows.length >= limit) {
          findings.push(
            `The report returned ${limit} rows (the limit) — events beyond it are absent from the volumes and may be misreported as zero_volume; raise limit.`
          );
        }

        return ok({
          period: { date_from: a.date_from, date_to: a.date_to },
          summary: {
            registered: userNames.filter((n) => registered.includes(n)).length,
            active: active.length,
            zero_volume: zeroVolume.length,
            expected_missing: expectedMissing.length,
            unexpected: expected ? active.filter((e) => !expected.has(e.name)).length : 0,
            system: systemEvents.length,
          },
          events,
          system_events: systemEvents,
          findings,
        });
      } catch (e) {
        return err(e);
      }
    }
  );
}
