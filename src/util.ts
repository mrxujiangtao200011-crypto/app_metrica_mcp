import type { ToolResult } from "./server.js";

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function err(e: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  };
}

// Refusal returned by the AppMetrica write tools when APPMETRICA_ALLOW_WRITE is not "true".
export function writeDisabled(): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: "Write operations are disabled. Set APPMETRICA_ALLOW_WRITE=true to enable." }],
  };
}

// Subset of the Reporting API response (/stat/v1/data and /stat/v1/data/bytime) used by the helpers.
export type ReportResponse = {
  data?: Array<{ dimensions?: Array<Record<string, unknown>>; metrics?: unknown[] }>;
  totals?: unknown[];
  time_intervals?: unknown[];
  sampled?: boolean;
  sample_share?: number;
};

// "ym:r2:revenue<currency>" -> "ym:r2"
export function namespaceOf(key: string): string {
  return key.split(":").slice(0, 2).join(":");
}
