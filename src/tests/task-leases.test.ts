import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  cancelTask,
  claimTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  DEFAULT_MAX_TASK_ATTEMPTS,
  failTask,
  getDb,
  getDeadLetterTasks,
  getTaskById,
  initDb,
  pauseTask,
  reclaimExpiredTaskLeases,
  reclaimTaskLease,
  renewTaskLease,
  requeueDeadLetterTask,
  resumeTask,
  startTask,
  TASK_LEASE_DURATION_MS,
  updateTaskProgress,
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

  // Once the retry budget is spent, dead_letter must behave as a terminal state.
  // Every one of these was an escape hatch: dead_letter was missing from the
  // terminal-status lists, so ordinary task operations silently revived a task
  // that had already exhausted its bound.
  describe("dead_letter is terminal", () => {
    function deadLetter(): string {
      const task = createTaskExtended("exhausts its budget");
      for (let i = 0; i < DEFAULT_MAX_TASK_ATTEMPTS; i++) {
        claimTask(task.id, agentA);
        expireLease(task.id);
        reclaimExpiredTaskLeases();
      }
      expect(getTaskById(task.id)?.status).toBe("dead_letter");
      return task.id;
    }

    test("a progress update does not resurrect it", () => {
      const id = deadLetter();
      updateTaskProgress(id, "still going");
      expect(getTaskById(id)?.status).toBe("dead_letter");
    });

    test("startTask cannot restart it", () => {
      const id = deadLetter();
      expect(startTask(id)).toBeNull();
      expect(getTaskById(id)?.status).toBe("dead_letter");
    });

    test("completeTask, failTask and cancelTask are no-ops on it", () => {
      const id = deadLetter();
      expect(completeTask(id, "done")).toBeNull();
      expect(failTask(id, "nope")).toBeNull();
      expect(cancelTask(id, "nope")).toBeNull();
      expect(getTaskById(id)?.status).toBe("dead_letter");
    });

    test("it is only revived through the explicit requeue path", () => {
      const id = deadLetter();
      expect(requeueDeadLetterTask(id)?.status).toBe("unassigned");
    });
  });

  // The direct-assign path: a task assigned to an agent and then started, rather
  // than claimed from the pool. It used to run with a null lease and an attempt
  // count that never moved, so the retry budget did not bound it.
  describe("direct-assign path", () => {
    function directlyAssignedInProgress(): string {
      const task = createTaskExtended("assigned directly, not claimed from the pool", {
        agentId: agentA,
      });
      expect(getTaskById(task.id)?.status).toBe("pending");
      startTask(task.id);
      expect(getTaskById(task.id)?.status).toBe("in_progress");
      return task.id;
    }

    test("startTask takes a lease and counts the attempt", () => {
      const id = directlyAssignedInProgress();
      const task = getTaskById(id);

      expect(task?.leaseOwnerId).toBe(agentA);
      expect(task?.attempts).toBe(1);
      expect(new Date(task!.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    });

    test("starting an already-running task does not count a second attempt", () => {
      const id = directlyAssignedInProgress();
      startTask(id);
      startTask(id);

      // Otherwise a redundant call would walk a healthy task toward dead_letter.
      expect(getTaskById(id)?.attempts).toBe(1);
    });

    test("its lease expires like any other, and the reaper requeues it", () => {
      const id = directlyAssignedInProgress();
      expireLease(id);

      const reclaimed = reclaimExpiredTaskLeases();
      expect(reclaimed.map((r) => r.taskId)).toContain(id);
      expect(getTaskById(id)?.status).toBe("unassigned");
    });

    test("a live worker keeps it by renewing the lease", () => {
      const id = directlyAssignedInProgress();
      expireLease(id);

      expect(renewTaskLease(id, agentA)).toBe(true);
      expect(reclaimExpiredTaskLeases()).toHaveLength(0);
      expect(getTaskById(id)?.status).toBe("in_progress");
    });

    test("its retry budget is bounded, so it reaches dead_letter", () => {
      const id = directlyAssignedInProgress();

      // One attempt is already spent by the first start. Burn the rest.
      for (let i = 1; i < DEFAULT_MAX_TASK_ATTEMPTS; i++) {
        expireLease(id);
        reclaimExpiredTaskLeases();
        getDb().prepare("UPDATE agent_tasks SET agentId = ? WHERE id = ?").run(agentA, id);
        startTask(id);
      }
      expireLease(id);
      reclaimExpiredTaskLeases();

      expect(getTaskById(id)?.attempts).toBe(DEFAULT_MAX_TASK_ATTEMPTS);
      expect(getTaskById(id)?.status).toBe("dead_letter");
    });

    test("resuming a paused task re-leases it without spending an attempt", () => {
      const id = directlyAssignedInProgress();
      pauseTask(id);
      expect(getTaskById(id)?.status).toBe("paused");

      const resumed = resumeTask(id);
      expect(resumed?.status).toBe("in_progress");
      expect(resumed?.leaseOwnerId).toBe(agentA);
      // A pause/resume across a graceful shutdown continues the same attempt.
      // Counting it would dead-letter a task that legitimately paused 3 times.
      expect(resumed?.attempts).toBe(1);
    });
  });
});
