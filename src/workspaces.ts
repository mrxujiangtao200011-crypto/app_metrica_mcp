import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WidgetSpec } from "./dashboards.js";

// Local store of named widget sets. AppMetrica web workspaces are not reachable through the
// public API, so this JSON file is the MCP's own "workspaces".

export type Workspace = {
  app_id?: number;
  description?: string;
  widgets: WidgetSpec[];
  updated_at: string;
};

type Store = { version: 1; workspaces: Record<string, Workspace> };

async function load(file: string): Promise<Store> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: {} };
    throw e;
  }
  const parsed = JSON.parse(raw) as Partial<Store>;
  if (parsed.version !== 1 || typeof parsed.workspaces !== "object" || parsed.workspaces === null) {
    throw new Error(`Unsupported workspaces file format: ${file}`);
  }
  return parsed as Store;
}

async function save(file: string, store: Store): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export async function listWorkspaces(file: string): Promise<Record<string, Workspace>> {
  return (await load(file)).workspaces;
}

export async function getWorkspace(file: string, name: string): Promise<Workspace> {
  const all = (await load(file)).workspaces;
  const workspace = Object.hasOwn(all, name) ? all[name] : undefined;
  if (!workspace) throw new Error(`Workspace "${name}" not found`);
  return workspace;
}

export async function saveWorkspace(
  file: string,
  name: string,
  data: { widgets: WidgetSpec[]; app_id?: number; description?: string }
): Promise<Workspace> {
  const store = await load(file);
  const workspace: Workspace = { ...data, updated_at: new Date().toISOString() };
  store.workspaces[name] = workspace;
  await save(file, store);
  return workspace;
}

export async function deleteWorkspace(file: string, name: string): Promise<void> {
  const store = await load(file);
  if (!Object.hasOwn(store.workspaces, name)) throw new Error(`Workspace "${name}" not found`);
  delete store.workspaces[name];
  await save(file, store);
}
