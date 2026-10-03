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

if (command === "auth") {
  // One-time token setup: browser consent → token saved to ~/.config/appmetrica-mcp/credentials.json.
  const { runAuthWizard } = await import("./auth.js");
  const manual = process.argv.includes("--manual");
  const loopback = process.argv.includes("--loopback");
  try {
    const { file, applications, credentials } = await runAuthWizard({ manual, loopback });
    console.error(`\n✓ Token saved to ${file} (${applications} AppMetrica application(s) visible${credentials.expires_at ? `, valid until ${credentials.expires_at.slice(0, 10)}` : ""}).`);
    console.error(
      process.env.APPMETRICA_OAUTH_TOKEN
        ? "Note: APPMETRICA_OAUTH_TOKEN is set in this environment and takes precedence over the saved file."
        : "The MCP server picks it up automatically — no APPMETRICA_OAUTH_TOKEN needed."
    );
    if (process.stdin.isTTY && !process.argv.includes("--no-web")) {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      let answer = "";
      try {
        answer = await rl.question("\nAlso log in to the AppMetrica web session now (needed only for workspaces/dashboards, opens Chrome)? [y/N] ");
      } finally {
        rl.close();
      }
      if (/^y(es)?$/i.test(answer.trim())) {
        try {
          const { loginInteractive, profileDir } = await import("./web/session.js");
          console.error("Opening Chrome — log in to Yandex in the window that appears…");
          const { login } = await loginInteractive();
          console.error(`✓ Web session saved${login ? ` for ${login}` : ""} in ${profileDir()}.`);
        } catch (e) {
          console.error(`Web session login did not complete (${e instanceof Error ? e.message : String(e)}); the token is saved anyway — run \`npx appmetrica-mcp login\` later.`);
        }
      }
    }
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
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
