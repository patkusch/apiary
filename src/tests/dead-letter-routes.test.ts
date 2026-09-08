// dead_letter over HTTP: list the parked tasks and requeue one deliberately.
//
// Boots a real HTTP server through `handleCore` (auth gate) → `handleTasks`,
// the same way the budgets tests do, so the API-key check is exercised too.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  DEFAULT_MAX_TASK_ATTEMPTS,
  getDb,
  getTaskById,
  initDb,
  reclaimExpiredTaskLeases,
  TASK_LEASE_DURATION_MS,
} from "../be/db";
import { handleCore } from "../http/core";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-dead-letter-routes.sqlite";
const API_KEY = "test-dead-letter-secret";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, apiKey)) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (!(await handleTasks(req, res, pathSegments, queryParams, myAgentId))) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;
let worker: string;

function expireLease(taskId: string): void {
  const expired = new Date(Date.now() - TASK_LEASE_DURATION_MS - 1000).toISOString();
  getDb().prepare("UPDATE agent_tasks SET leaseExpiresAt = ? WHERE id = ?").run(expired, taskId);
}

/** Burn a task's whole retry budget: claim, crash, repeat. */
function deadLetter(description: string): string {
  const task = createTaskExtended(description);
  for (let i = 0; i < DEFAULT_MAX_TASK_ATTEMPTS; i++) {
    claimTask(task.id, worker);
    expireLease(task.id);
    reclaimExpiredTaskLeases();
  }
  expect(getTaskById(task.id)?.status).toBe("dead_letter");
  return task.id;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createTestServer(API_KEY);
  port = await listen(server);
});

beforeEach(() => {
  getDb().run("DELETE FROM agent_tasks");
  worker = createAgent({ name: `worker-${crypto.randomUUID()}`, isLead: false, status: "idle" }).id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("GET /api/dead-letter-tasks", () => {
  test("lists only dead-lettered tasks, and needs the API key", async () => {
    const parked = deadLetter("poison task");
    createTaskExtended("healthy task");

    const res = await api("/api/dead-letter-tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string; status: string }> };
    expect(body.tasks.map((t) => t.id)).toEqual([parked]);
    expect(body.tasks[0].status).toBe("dead_letter");

    const anon = await fetch(`http://localhost:${port}/api/dead-letter-tasks`);
    expect(anon.status).toBe(401);
  });

  test("honours limit", async () => {
    deadLetter("first");
    deadLetter("second");
    const res = await api("/api/dead-letter-tasks?limit=1");
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(1);
  });
});

describe("POST /api/tasks/{id}/requeue", () => {
  test("returns a dead-lettered task to the pool with a fresh budget, so it can be claimed again", async () => {
    const id = deadLetter("recoverable task");
    const before = getTaskById(id)!;

    const res = await api(`/api/tasks/${id}/requeue`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      task: { status: string; maxAttempts: number };
    };
    expect(body.success).toBe(true);
    expect(body.task.status).toBe("unassigned");
    expect(body.task.maxAttempts).toBe(before.attempts + DEFAULT_MAX_TASK_ATTEMPTS);

    expect(claimTask(id, worker)).not.toBeNull();
    const list = (await (await api("/api/dead-letter-tasks")).json()) as { tasks: unknown[] };
    expect(list.tasks).toHaveLength(0);
  });

  test("works with no request body at all", async () => {
    const id = deadLetter("curl with no -d");
    const res = await api(`/api/tasks/${id}/requeue`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(getTaskById(id)?.status).toBe("unassigned");
  });

  test("extraAttempts sets the size of the new budget", async () => {
    const id = deadLetter("one more go");
    const before = getTaskById(id)!;
    const res = await api(`/api/tasks/${id}/requeue`, {
      method: "POST",
      body: JSON.stringify({ extraAttempts: 1 }),
    });
    expect(res.status).toBe(200);
    expect(getTaskById(id)?.maxAttempts).toBe(before.attempts + 1);
  });

  test("refuses a task that is not dead-lettered, and an unknown one", async () => {
    const healthy = createTaskExtended("healthy task");
    const conflict = await api(`/api/tasks/${healthy.id}/requeue`, { method: "POST", body: "{}" });
    expect(conflict.status).toBe(409);
    expect(getTaskById(healthy.id)?.status).toBe("unassigned");

    const missing = await api(`/api/tasks/${crypto.randomUUID()}/requeue`, {
      method: "POST",
      body: "{}",
    });
    expect(missing.status).toBe(404);
  });
});
