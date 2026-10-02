import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { AppMetricaClient } from "./client.js";
import { registerManagementTools } from "./tools/management.js";
import { registerReportingTools } from "./tools/reporting.js";
import { registerLogTools } from "./tools/logs.js";
import { registerPushTools } from "./tools/push.js";
import { registerSegmentTools } from "./tools/segments.js";
import { registerFunnelTools } from "./tools/funnels.js";
import { registerDashboardTools } from "./tools/dashboards.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerWebTools } from "./tools/web.js";
import { analyticsSetupPrompt } from "./prompts.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export type ServerAdapter = {
  tool: (name: string, description: string, schema: z.ZodRawShape, handler: ToolHandler) => void;
};

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: "appmetrica-mcp",
    version: "0.3.0",
  });

  const client = new AppMetricaClient(config);

  const serverAdapter: ServerAdapter = {
    tool(name, description, schema, handler): void {
      server.tool(name, description, schema, async (args) => {
        return handler(args as Record<string, unknown>);
      });
    },
  };

  registerManagementTools(serverAdapter, client);
  registerReportingTools(serverAdapter, client);
  registerLogTools(serverAdapter, client);
  registerPushTools(serverAdapter, client, config);
  registerSegmentTools(serverAdapter, client, config);
  registerFunnelTools(serverAdapter, client, config);
  registerAuditTools(serverAdapter, client);
  registerDashboardTools(serverAdapter, client, config);
  registerWebTools(serverAdapter, client, config);

  server.prompt(
    "analytics_setup",
    "Analyse an app's AppMetrica analytics and (optionally) its source code, build funnels, segments and a dashboard, and report instrumentation gaps.",
    {
      app_id: z.string().describe("AppMetrica application ID"),
      project_path: z.string().optional().describe("Path to the app's source code, to find AppMetrica event calls"),
      goal: z.string().optional().describe("What the analytics should answer, e.g. 'understand paywall conversion'"),
    },
    (args) => ({
      messages: [{ role: "user", content: { type: "text", text: analyticsSetupPrompt(args) } }],
    })
  );

  return server;
}
