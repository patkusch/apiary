// A worker whose lease just expired must not be handed the same task again
// while another worker can take it, and must not count as a healthy idle worker
// until it proves it is alive (its next /ping, /api/poll or re-registration).
//
// Before this, reclaiming an expired lease left the silent worker marked idle.
// The heartbeat hands pool tasks to "the first idle worker in registration
// order", so when the silent worker was first, it got the task straight back
// and burned one of the three attempts before anyone else saw it.

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
  getAgentById,
  getDb,
  getIdleWorkersWithCapacity,
  getTaskById,
  initDb,
  insertActiveSession,
  reclaimExpiredTaskLeases,
  requeueDeadLetterTask,
  startTask,
  TASK_LEASE_DURATION_MS,
} from "../be/db";
import { codeLevelTriage, preflightGate } from "../heartbeat/heartbeat";
import { handleAgentRegister } from "../http/agents";
import { handleCore } from "../http/core";
import { handlePoll } from "../http/poll";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-lease-lost-assignment.sqlite";
const API_KEY = "test-lease-lost-secret";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

let server: Server;
let port: number;

async function listen(s: Server): Promise<number> {
  await new Promise<void>((resolve) => s.listen(0, resolve));
  const addr = s.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

/** The same handlers the real server chains, in the same order. */
function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (await handleAgentRegister(req, res, pathSegments, myAgentId)) return;
    if (await handlePoll(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end("Not Found");
  });
}

function call(path: string, agentId: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Agent-ID": agentId,
    },
  });
}

/** What a worker's own loop does every iteration to say "I am here". */
async function ping(agentId: string): Promise<void> {
  const res = await call("/ping", agentId, { method: "POST" });
  expect(res.status).toBe(204);
}

function register(name: string): string {
  return createAgent({ name, isLead: false, status: "idle" }).id;
}

/** Simulate the passage of time by ageing a task's lease directly. */
function expireLease(taskId: string): void {
  const expired = new Date(Date.now() - TASK_LEASE_DURATION_MS - 1000).toISOString();
  getDb().prepare("UPDATE agent_tasks SET leaseExpiresAt = ? WHERE id = ?").run(expired, taskId);
}

/** The worker finishes the task cleanly and goes back to idle. */
function finish(taskId: string, agentId: string): void {
  getDb().prepare("UPDATE agent_tasks SET status = 'completed' WHERE id = ?").run(taskId);
  getDb().prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agentId);
}

/**
 * Two heartbeat sweeps. The first one reclaims the expired lease; the second is
 * the one that picks a worker for the requeued task, which is where the bug was.
 */
async function sweepTwice(): Promise<void> {
  await codeLevelTriage();
  await codeLevelTriage();
}

function leaseLostAt(agentId: string): string | null {
  const row = getDb()
    .prepare<{ leaseLostAt: string | null }, [string]>(
      "SELECT leaseLostAt FROM agents WHERE id = ?",
    )
    .get(agentId);
  return row?.leaseLostAt ?? null;
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);
  server = createTestServer();
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  getDb().run("DELETE FROM agent_tasks");
  getDb().run("DELETE FROM agents");
  getDb().run("DELETE FROM active_sessions");
});

describe("a worker that lost its lease", () => {
  // The reproduction, and its mirror image. Only one registration order failed
  // before the fix, which is what made it easy to miss.
  for (const order of [["worker-a", "worker-b"] as const, ["worker-b", "worker-a"] as const]) {
    test(`is not handed the task back (registered ${order.join(" then ")})`, async () => {
      const ids = new Map(order.map((name) => [name, register(name)]));
      const a = ids.get("worker-a") as string;
      const b = ids.get("worker-b") as string;

      const task = createTaskExtended("Rename the old config flag");
      expect(claimTask(task.id, a)).not.toBeNull();
      // worker-a now goes silent: no renewals, no pings.
      expireLease(task.id);

      await sweepTwice();

      const after = getTaskById(task.id);
      expect(after?.status).toBe("in_progress");
      expect(after?.agentId).toBe(b);
      expect(after?.attempts).toBe(2);
    });
  }

  test("is left out of the idle workers the moment its lease is reclaimed", () => {
    const a = register("worker-a");
    const b = register("worker-b");
    const task = createTaskExtended("Work that must survive");
    claimTask(task.id, a);
    expireLease(task.id);
    // The worker's own status still says idle, as it did before the fix.
    getDb().prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);

    const [reclaimed] = reclaimExpiredTaskLeases();

    expect(reclaimed?.previousOwnerId).toBe(a);
    expect(getAgentById(a)?.status).toBe("idle");
    expect(leaseLostAt(a)).not.toBeNull();
    expect(getIdleWorkersWithCapacity().map((w) => w.id)).toEqual([b]);
  });

  test("does not make the preflight gate think there is a worker to assign to", () => {
    const a = register("worker-a");
    const task = createTaskExtended("Waiting in the pool");
    claimTask(task.id, a);
    expireLease(task.id);
    reclaimExpiredTaskLeases();

    expect(getTaskById(task.id)?.status).toBe("unassigned");
    expect(preflightGate()).toBe(false);
  });

  test("only the worker that lost the lease is affected", async () => {
    const a = register("worker-a");
    const b = register("worker-b");
    const task = createTaskExtended("Some task");
    claimTask(task.id, a);
    expireLease(task.id);
    await sweepTwice();

    expect(leaseLostAt(a)).not.toBeNull();
    expect(leaseLostAt(b)).toBeNull();
  });
});

describe("a worker that is the only one", () => {
  test("is not handed the task while it is silent", async () => {
    const a = register("worker-a");
    const task = createTaskExtended("Only one worker exists");
    claimTask(task.id, a);
    expireLease(task.id);

    await sweepTwice();

    const after = getTaskById(task.id);
    expect(after?.status).toBe("unassigned");
    expect(after?.attempts).toBe(1);
  });

  test("gets the task again after its next ping", async () => {
    const a = register("worker-a");
    const task = createTaskExtended("Only one worker exists");
    claimTask(task.id, a);
    expireLease(task.id);
    await sweepTwice();
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    await ping(a);
    expect(leaseLostAt(a)).toBeNull();
    await codeLevelTriage();

    const after = getTaskById(task.id);
    expect(after?.status).toBe("in_progress");
    expect(after?.agentId).toBe(a);
    expect(after?.attempts).toBe(2);
  });

  test("gets the task again when it polls, without waiting for a sweep", async () => {
    const a = register("worker-a");
    const task = createTaskExtended("Only one worker exists");
    claimTask(task.id, a);
    expireLease(task.id);
    await sweepTwice();

    const res = await call("/api/poll", a);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trigger: { type: string; taskId: string } | null };
    expect(body.trigger?.type).toBe("task_assigned");
    expect(body.trigger?.taskId).toBe(task.id);
    expect(getTaskById(task.id)?.attempts).toBe(2);
    expect(leaseLostAt(a)).toBeNull();
  });

  test("gets the task again when it registers again after a restart", async () => {
    const a = register("worker-a");
    const task = createTaskExtended("Only one worker exists");
    claimTask(task.id, a);
    expireLease(task.id);
    await sweepTwice();

    const res = await call("/api/agents", a, {
      method: "POST",
      body: JSON.stringify({ name: "worker-a" }),
    });
    expect(res.ok).toBe(true);
    expect(leaseLostAt(a)).toBeNull();

    await codeLevelTriage();
    expect(getTaskById(task.id)?.agentId).toBe(a);
  });
});

describe("a worker that proves it is alive", () => {
  test("is passed over until it pings, and chosen again once it has", async () => {
    const a = register("worker-a");
    const b = register("worker-b");
    const first = createTaskExtended("First task");
    claimTask(first.id, a);
    expireLease(first.id);
    await sweepTwice();
    expect(getTaskById(first.id)?.agentId).toBe(b);
    finish(first.id, b);

    // Still silent, so worker-a is passed over even though it is first in line.
    const second = createTaskExtended("Second task");
    await codeLevelTriage();
    expect(getTaskById(second.id)?.agentId).toBe(b);
    finish(second.id, b);

    // Once it pings it is a healthy idle worker again and, being first, is chosen.
    await ping(a);
    const third = createTaskExtended("Third task");
    await codeLevelTriage();
    expect(getTaskById(third.id)?.agentId).toBe(a);
  });

  test("a ping from another worker does not clear it", async () => {
    const a = register("worker-a");
    const b = register("worker-b");
    const task = createTaskExtended("Some task");
    claimTask(task.id, a);
    expireLease(task.id);
    await sweepTwice();

    await ping(b);

    expect(leaseLostAt(a)).not.toBeNull();
  });
});

describe("the retry budget is untouched", () => {
  test("a task nobody alive can take waits in the pool and burns no attempt", async () => {
    const a = register("worker-a");
    const b = register("worker-b");
    const task = createTaskExtended("Everyone crashes on this");

    claimTask(task.id, a);
    expireLease(task.id);
    await sweepTwice();
    expect(getTaskById(task.id)?.agentId).toBe(b);
    expect(getTaskById(task.id)?.attempts).toBe(2);

    // worker-b goes silent too. Nobody is alive, so nobody is handed the task.
    expireLease(task.id);
    await sweepTwice();
    await sweepTwice();

    const waiting = getTaskById(task.id);
    expect(waiting?.status).toBe("unassigned");
    expect(waiting?.attempts).toBe(2);

    // worker-b comes back and gets the third and last attempt.
    await ping(b);
    await codeLevelTriage();
    const last = getTaskById(task.id);
    expect(last?.agentId).toBe(b);
    expect(last?.attempts).toBe(3);
  });

  test("three of three still ends in dead_letter, and requeue still works", async () => {
    const a = register("worker-a");
    const task = createTaskExtended("Poison task");

    for (let i = 0; i < DEFAULT_MAX_TASK_ATTEMPTS; i++) {
      // The worker comes back, takes the task, and dies on it.
      await ping(a);
      const res = await call("/api/poll", a);
      const body = (await res.json()) as { trigger: { taskId: string } | null };
      expect(body.trigger?.taskId).toBe(task.id);
      expireLease(task.id);
      await sweepTwice();
    }

    const parked = getTaskById(task.id);
    expect(parked?.status).toBe("dead_letter");
    expect(parked?.attempts).toBe(DEFAULT_MAX_TASK_ATTEMPTS);

    const revived = requeueDeadLetterTask(task.id);
    expect(revived?.status).toBe("unassigned");
    await ping(a);
    await codeLevelTriage();
    const again = getTaskById(task.id);
    expect(again?.agentId).toBe(a);
    expect(again?.attempts).toBe(DEFAULT_MAX_TASK_ATTEMPTS + 1);
  });

  test("the five-minute stall check still takes a dead worker offline", async () => {
    const a = register("worker-a");
    const b = register("worker-b");
    const task = createTaskExtended("Stalled task", { agentId: a });
    startTask(task.id);
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [old, task.id]);

    await codeLevelTriage();

    expect(getAgentById(a)?.status).toBe("offline");
    expect(leaseLostAt(a)).not.toBeNull();
    expect(getTaskById(task.id)?.agentId).toBe(b);

    // Coming back clears both.
    await ping(a);
    expect(getAgentById(a)?.status).toBe("idle");
    expect(leaseLostAt(a)).toBeNull();
  });

  test("a worker with a live session and a fresh lease is never flagged", async () => {
    const a = register("worker-a");
    const task = createTaskExtended("Healthy long task");
    claimTask(task.id, a);
    insertActiveSession({ agentId: a, taskId: task.id, triggerType: "task_assigned" });

    await codeLevelTriage();

    expect(getTaskById(task.id)?.agentId).toBe(a);
    expect(leaseLostAt(a)).toBeNull();
  });
});
