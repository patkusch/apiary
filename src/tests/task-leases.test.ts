import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  DEFAULT_MAX_TASK_ATTEMPTS,
  getDb,
  getDeadLetterTasks,
  getTaskById,
  initDb,
  reclaimExpiredTaskLeases,
  reclaimTaskLease,
  renewTaskLease,
  requeueDeadLetterTask,
  TASK_LEASE_DURATION_MS,
} from "../be/db";

const TEST_DB_PATH = "./test-task-leases.sqlite";

let agentA: string;
let agentB: string;

/** Simulate the passage of time by ageing a task's lease directly. */
function expireLease(taskId: string, byMs = TASK_LEASE_DURATION_MS + 1000): void {
  const expired = new Date(Date.now() - byMs).toISOString();
  getDb().prepare("UPDATE agent_tasks SET leaseExpiresAt = ? WHERE id = ?").run(expired, taskId);
}

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  initDb(TEST_DB_PATH);
});

beforeEach(() => {
  getDb().run("DELETE FROM agent_tasks");
  agentA = createAgent({
    name: `worker-a-${crypto.randomUUID()}`,
    isLead: false,
    status: "idle",
  }).id;
  agentB = createAgent({
    name: `worker-b-${crypto.randomUUID()}`,
    isLead: false,
    status: "idle",
  }).id;
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
});

describe("task leases", () => {
  test("claiming a task takes a lease and counts the attempt", () => {
    const task = createTaskExtended("ship the thing");
    const claimed = claimTask(task.id, agentA);

    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseOwnerId).toBe(agentA);
    expect(claimed?.leaseExpiresAt).toBeDefined();
    expect(new Date(claimed!.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  test("only one worker can claim a task", () => {
    const task = createTaskExtended("contended task");

    expect(claimTask(task.id, agentA)).not.toBeNull();
    expect(claimTask(task.id, agentB)).toBeNull();
  });

  test("a live worker keeps its task by renewing the lease", () => {
    const task = createTaskExtended("long running task");
    claimTask(task.id, agentA);
    expireLease(task.id);

    expect(renewTaskLease(task.id, agentA)).toBe(true);

    // The lease is fresh again, so the reaper must leave the task alone.
    expect(reclaimExpiredTaskLeases()).toHaveLength(0);
    expect(getTaskById(task.id)?.status).toBe("in_progress");
  });

  test("a worker cannot renew a lease it no longer owns", () => {
    const task = createTaskExtended("stolen task");
    claimTask(task.id, agentA);

    expect(renewTaskLease(task.id, agentB)).toBe(false);
  });

  // This is the regression that motivated the fork: upstream called failTask()
  // here, so a crashed worker silently destroyed in-flight work.
  test("a crashed worker's task is requeued, not failed", () => {
    const task = createTaskExtended("work that must survive a crash");
    claimTask(task.id, agentA);
    expireLease(task.id);

    const reclaimed = reclaimExpiredTaskLeases();
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      taskId: task.id,
      previousOwnerId: agentA,
      outcome: "requeued",
    });

    const after = getTaskById(task.id);
    expect(after?.status).toBe("unassigned");
    expect(after?.status).not.toBe("failed");
    expect(after?.agentId).toBeNull();
    expect(after?.leaseOwnerId).toBeUndefined();
  });

  test("a requeued task can be picked up and completed by another worker", () => {
    const task = createTaskExtended("resilient task");
    claimTask(task.id, agentA);
    expireLease(task.id);
    reclaimExpiredTaskLeases();

    const retried = claimTask(task.id, agentB);
    expect(retried).not.toBeNull();
    expect(retried?.leaseOwnerId).toBe(agentB);
    expect(retried?.attempts).toBe(2);
  });

  test("a task is dead-lettered once its retry budget is spent", () => {
    const task = createTaskExtended("poison task");

    // Burn the whole retry budget: claim, crash, repeat.
    for (let i = 0; i < DEFAULT_MAX_TASK_ATTEMPTS; i++) {
      expect(claimTask(task.id, agentA)).not.toBeNull();
      expireLease(task.id);
      reclaimExpiredTaskLeases();
    }

    const after = getTaskById(task.id);
    expect(after?.status).toBe("dead_letter");
    expect(after?.attempts).toBe(DEFAULT_MAX_TASK_ATTEMPTS);
    expect(getDeadLetterTasks().map((t) => t.id)).toContain(task.id);
  });

  test("a dead-lettered task can be requeued with a fresh budget", () => {
    const task = createTaskExtended("recoverable task");
    for (let i = 0; i < DEFAULT_MAX_TASK_ATTEMPTS; i++) {
      claimTask(task.id, agentA);
      expireLease(task.id);
      reclaimExpiredTaskLeases();
    }
    expect(getTaskById(task.id)?.status).toBe("dead_letter");

    const revived = requeueDeadLetterTask(task.id);
    expect(revived?.status).toBe("unassigned");
    expect(revived?.failureReason).toBeUndefined();
    expect(claimTask(task.id, agentB)).not.toBeNull();
  });

  test("a healthy in-flight task is never reclaimed", () => {
    const task = createTaskExtended("busy but healthy");
    claimTask(task.id, agentA);

    expect(reclaimExpiredTaskLeases()).toHaveLength(0);
    expect(getTaskById(task.id)?.status).toBe("in_progress");
  });

  test("reclaimTaskLease force-reclaims a task with a known-dead worker", () => {
    const task = createTaskExtended("worker vanished");
    claimTask(task.id, agentA);

    // No waiting for the lease clock — the heartbeat already proved it is dead.
    const result = reclaimTaskLease(task.id);
    expect(result?.outcome).toBe("requeued");
    expect(getTaskById(task.id)?.status).toBe("unassigned");
  });

  test("reclaimTaskLease ignores tasks that are not in flight", () => {
    const task = createTaskExtended("not started");
    expect(reclaimTaskLease(task.id)).toBeNull();
  });
});
