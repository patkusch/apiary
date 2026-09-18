/**
 * Starts what the dashboard test needs: the real API server (the same process
 * and short lease and heartbeat settings as scripts/e2e-dead-letter.ts) and a
 * static server for the dashboard exactly as `vite build` wrote it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIST = join(ROOT, "ui", "dist");

export const API_KEY = "e2e-dashboard";
export const API_PORT = Number(process.env.E2E_PORT) || 3921;
export const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT) || 5921;
export const API_URL = `http://localhost:${API_PORT}`;
export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export type Task = {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  failureReason?: string;
};

export type Stack = { stop: () => Promise<void> };

/** Serve ui/dist, sending index.html for any path that is not a file (the router). */
function serveDashboard(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
    let file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      file = join(DIST, "index.html");
    }
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(DASHBOARD_PORT, () => done(server));
  });
}

export async function api(path: string, init: RequestInit = {}, agentId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  if (agentId) headers["X-Agent-ID"] = agentId;
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

export async function getTask(id: string): Promise<Task> {
  const res = await api(`/api/tasks/${id}`);
  if (!res.ok) throw new Error(`GET /api/tasks/${id} returned ${res.status}`);
  return (await res.json()) as Task;
}

/** Poll until `probe` returns a value, or fail after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startStack(): Promise<Stack> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("ui/dist is missing: run `bun run build:dashboard` (e2e:dashboard does)");
  }
  const workDir = mkdtempSync(join(tmpdir(), "apiary-e2e-dashboard-"));
  const dashboard = await serveDashboard();
  const server: ChildProcess = spawn("bun", ["src/http.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      API_KEY,
      DATABASE_PATH: join(workDir, "e2e.sqlite"),
      TASK_LEASE_DURATION_MS: "1500",
      HEARTBEAT_INTERVAL_MS: "1000",
      HEARTBEAT_CHECKLIST_DISABLE: "1",
      OAUTH_KEEPALIVE_DISABLE: "true",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const exited = new Promise<void>((done) => server.once("exit", () => done()));
  const stop = async () => {
    server.kill();
    await exited;
    dashboard.close();
    rmSync(workDir, { recursive: true, force: true });
  };
  try {
    await waitFor("the API server to start", async () => {
      const res = await fetch(`${API_URL}/health`).catch(() => null);
      return res?.ok ? true : undefined;
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}
