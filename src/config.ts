import { NO_TOKEN_MESSAGE, resolveToken } from "./auth.js";
import os from "node:os";
import path from "node:path";

export interface Config {
  // Resolves the OAuth token on demand: APPMETRICA_OAUTH_TOKEN, else credentials saved by
  // `appmetrica-mcp auth` (refreshed when possible). Throws a readable error when there is none.
  getToken: () => Promise<string>;
  allowWrite: boolean;
  workspacesFile: string;
}

export function loadConfig(): Config {
  const allowWrite = process.env.APPMETRICA_ALLOW_WRITE === "true";
  const workspacesFile = process.env.APPMETRICA_WORKSPACES_FILE ?? path.join(os.homedir(), ".config", "appmetrica-mcp", "workspaces.json");
  let cached: string | undefined;
  const getToken = async (): Promise<string> => {
    if (process.env.APPMETRICA_OAUTH_TOKEN) return process.env.APPMETRICA_OAUTH_TOKEN;
    cached = (await resolveToken()) ?? cached;
    if (!cached) throw new Error(NO_TOKEN_MESSAGE);
    return cached;
  };
  return { getToken, allowWrite, workspacesFile };
}
