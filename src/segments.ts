import type { AppMetricaClient } from "./client.js";

// Saved segments are an undocumented Management endpoint; `expression` is a valid
// `filters` value for /stat/v1/data and /stat/v1/data/bytime.
export async function resolveSegmentExpression(
  client: AppMetricaClient,
  appId: number,
  segmentId: number
): Promise<string> {
  const data = await client.get<{ segment?: { expression?: string } }>(
    `/management/v1/application/${appId}/segment/${segmentId}`
  );
  const expression = data.segment?.expression;
  if (!expression) {
    throw new Error(`Segment ${segmentId} of app ${appId} has no expression`);
  }
  return expression;
}

export function combineFilters(segmentExpr?: string, filters?: string): string | undefined {
  if (segmentExpr && filters) return `(${segmentExpr}) and (${filters})`;
  return segmentExpr || filters || undefined;
}

// ---- Segments (write side) ----

export type Segment = {
  segment_id: number;
  api_key?: string;
  name: string;
  params?: unknown;
  expression: string;
  owner?: string;
  edit_access?: boolean;
};

// `params` is the web editor's filter JSON — the API accepts it only as a JSON *string* and
// DERIVES `expression` from it (a raw expression without matching params is stored empty).
export type SegmentBody = { name: string; expression: string; params: string };

const esc = (value: string): string => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// "Did all of these client events" segment: expression plus the filter JSON the web segment editor renders.
export function segmentFromEvents(events: string[]): { expression: string; params: string } {
  if (events.length === 0) throw new Error("events must not be empty");
  return {
    expression: events.map((e) => `exists ym:ce:device with (eventLabel=='${esc(e)}')`).join(" and "),
    params: JSON.stringify({
      filters: events.map((e) => ({
        id: "userClientEvents",
        data: { inverted: false, paths: [{ path: [e] }], combinePolicy: "and" },
      })),
    }),
  };
}

export async function getSegment(client: AppMetricaClient, appId: number, segmentId: number): Promise<Segment> {
  const data = await client.get<{ segment?: Segment }>(`/management/v1/application/${appId}/segment/${segmentId}`);
  if (!data.segment) throw new Error(`Segment ${segmentId} of app ${appId} not found`);
  return data.segment;
}

export async function createSegment(client: AppMetricaClient, appId: number, body: SegmentBody): Promise<Segment> {
  const data = await client.post<{ segment: Segment }>(`/management/v1/application/${appId}/segments`, { segment: body });
  return data.segment;
}

export async function updateSegment(
  client: AppMetricaClient,
  appId: number,
  segmentId: number,
  body: SegmentBody
): Promise<Segment> {
  const data = await client.put<{ segment: Segment }>(`/management/v1/application/${appId}/segment/${segmentId}`, {
    segment: body,
  });
  return data.segment;
}

export async function deleteSegment(client: AppMetricaClient, appId: number, segmentId: number): Promise<unknown> {
  return client.delete<unknown>(`/management/v1/application/${appId}/segment/${segmentId}`);
}
