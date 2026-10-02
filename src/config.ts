import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  oauthToken: string;
  allowWrite: boolean;
  workspacesFile: string;
}

export function loadConfig(): Config {
  const oauthToken = process.env.APPMETRICA_OAUTH_TOKEN;
  if (!oauthToken) {
    throw new Error("APPMETRICA_OAUTH_TOKEN env variable is required");
  }

  const allowWrite = process.env.APPMETRICA_ALLOW_WRITE === "true";
  const workspacesFile =
    process.env.APPMETRICA_WORKSPACES_FILE || join(homedir(), ".config", "appmetrica-mcp", "workspaces.json");

  return { oauthToken, allowWrite, workspacesFile };
}
