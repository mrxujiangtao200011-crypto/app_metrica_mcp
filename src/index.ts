#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const command = process.argv[2];

if (command === "login") {
  // One-time interactive login for the experimental web-session tools (dashboards / workspaces).
  const { loginInteractive, profileDir } = await import("./web/session.js");
  console.error("Opening Chrome — log in to Yandex in the window that appears (up to 10 minutes)…");
  const { login } = await loginInteractive();
  console.error(`Logged in${login ? ` as ${login}` : ""}. Session saved in ${profileDir()}; the MCP will reuse it headlessly.`);
  process.exit(0);
}

if (command === "session-status") {
  const { WebSession } = await import("./web/session.js");
  const session = new WebSession();
  try {
    console.log(JSON.stringify(await session.status(), null, 2));
  } finally {
    await session.close();
  }
  process.exit(0);
}

const { loadConfig } = await import("./config.js");
const { createServer } = await import("./server.js");
const config = loadConfig();
const server = createServer(config);
const transport = new StdioServerTransport();
await server.connect(transport);
