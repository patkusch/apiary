import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getActiveSessionForTask,
  getAgentById,
  getDb,
  getIdleWorkersWithCapacity,
  getStalledInProgressTasks,
  getTaskById,
  getUnassignedPoolTasks,
  initDb,
  insertActiveSession,
  startTask,
  updateAgentStatus,
} from "../be/db";
import {
  codeLevelTriage,
  getRebootAffectedTasks,
  preflightGate,
  runHeartbeatSweep,
  runRebootSweep,
  startHeartbeat,
  stopHeartbeat,
} from "../heartbeat/heartbeat";

const TEST_DB_PATH = "./test-heartbeat.sqlite";

describe("Heartbeat Triage", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    closeDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  // Clean up tasks between tests to avoid interference
  beforeEach(() => {
    getDb().run("DELETE FROM agent_tasks");
    getDb().run("DELETE FROM agents");
    getDb().run("DELETE FROM active_sessions");
  });

  // ==========================================================================
  // Tier 1: Preflight Gate
  // ==========================================================================

  describe("Preflight Gate", () => {
    test("returns false when no tasks and no agents exist", () => {
      expect(preflightGate()).toBe(false);
    });

    test("returns false when only completed tasks exist and agents are idle", () => {
      const agent = createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createTaskExtended("Completed task", { agentId: agent.id });
      // Manually mark as completed
      getDb().run(
        "UPDATE agent_tasks SET status = 'completed', finishedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE agentId = ?",
        [agent.id],
      );

      expect(preflightGate()).toBe(false);
    });

    test("returns true when unassigned pool tasks exist with idle workers", () => {
      createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createTaskExtended("Pool task");

      expect(preflightGate()).toBe(true);
    });

    test("returns true when in_progress tasks exist", () => {
      const agent = createAgent({ name: "busy-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Active task", { agentId: agent.id });
      startTask(task.id);

      expect(preflightGate()).toBe(true);
    });

    test("returns true when busy workers exist (need health check)", () => {
      createAgent({ name: "busy-worker", isLead: false, status: "busy" });

      expect(preflightGate()).toBe(true);
    });

    test("returns false when only offline agents exist", () => {
      createAgent({ name: "offline-worker", isLead: false, status: "offline" });

      expect(preflightGate()).toBe(false);
    });
  });

  // ==========================================================================
  // DB Query Functions
  // ==========================================================================

  describe("getStalledInProgressTasks", () => {
    test("returns tasks with stale lastUpdatedAt", () => {
      const agent = createAgent({ name: "stall-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: agent.id });
      startTask(task.id);

      // Manually set lastUpdatedAt to 45 minutes ago
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      const stalled = getStalledInProgressTasks(30);
      expect(stalled.length).toBe(1);
      expect(stalled[0]!.id).toBe(task.id);
    });

    test("does not return recently updated in_progress tasks", () => {
      const agent = createAgent({ name: "active-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Active task", { agentId: agent.id });
      startTask(task.id);

      const stalled = getStalledInProgressTasks(30);
      expect(stalled.length).toBe(0);
    });
  });

  describe("getActiveSessionForTask", () => {
    test("returns active session for task", () => {
      const agent = createAgent({ name: "worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Task", { agentId: agent.id });
      startTask(task.id);

      insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });

      const session = getActiveSessionForTask(task.id);
      expect(session).not.toBeNull();
      expect(session!.taskId).toBe(task.id);
    });

    test("returns null when no session exists", () => {
      const session = getActiveSessionForTask("non-existent-task-id");
      expect(session).toBeNull();
    });
  });

  describe("getIdleWorkersWithCapacity", () => {
    test("returns idle non-lead agents", () => {
      createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createAgent({ name: "idle-lead", isLead: true, status: "idle" });
      createAgent({ name: "busy-worker", isLead: false, status: "busy" });
      createAgent({ name: "offline-worker", isLead: false, status: "offline" });

      const workers = getIdleWorkersWithCapacity();
      expect(workers.length).toBe(1);
      expect(workers[0]!.name).toBe("idle-worker");
    });

    test("excludes workers at max capacity", () => {
      const agent = createAgent({ name: "full-worker", isLead: false, status: "idle" });
      // maxTasks defaults to 1, so create one in_progress task
      const task = createTaskExtended("Existing task", { agentId: agent.id });
      startTask(task.id);

      const workers = getIdleWorkersWithCapacity();
      expect(workers.length).toBe(0);
    });
  });

  describe("getUnassignedPoolTasks", () => {
    test("returns unassigned tasks ordered by priority then creation time", () => {
      createTaskExtended("Low priority", { priority: 30 });
      createTaskExtended("High priority", { priority: 80 });
      createTaskExtended("Medium priority", { priority: 50 });

      const tasks = getUnassignedPoolTasks(10);
      expect(tasks.length).toBe(3);
      expect(tasks[0]!.priority).toBe(80);
      expect(tasks[1]!.priority).toBe(50);
      expect(tasks[2]!.priority).toBe(30);
    });

    test("respects limit parameter", () => {
      createTaskExtended("Task 1");
      createTaskExtended("Task 2");
      createTaskExtended("Task 3");

      const tasks = getUnassignedPoolTasks(2);
      expect(tasks.length).toBe(2);
    });
  });

  // ==========================================================================
  // Tier 2: Code-Level Triage
  // ==========================================================================

  describe("Code-Level Triage", () => {
    test("requeues stalled task with no active session", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: agent.id });
      startTask(task.id);

      // Make task stale (10 min — past the 5 min no-session threshold)
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      const findings = await codeLevelTriage();

      expect(findings.reclaimedTasks.length).toBe(1);
      expect(findings.reclaimedTasks[0]!.taskId).toBe(task.id);
      expect(findings.reclaimedTasks[0]!.outcome).toBe("requeued");
      expect(findings.stalledTasks.length).toBe(0);

      // A dead worker is a scheduling event, not a task failure: the work goes
      // back in the pool for another worker instead of being discarded.
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("unassigned");
      expect(updated?.agentId).toBeNull();

      // And the dead worker is taken out of the scheduling pool, so the task
      // cannot be handed straight back to it.
      expect(getAgentById(agent.id)?.status).toBe("offline");
    });

    test("requeues stalled task with stale session heartbeat", async () => {
      const agent = createAgent({ name: "crashed-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: agent.id });
      startTask(task.id);

      // Create an active session with stale heartbeat
      insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });
      // Make both task and session heartbeat stale (20 min — past the 15 min threshold)
      const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);
      getDb().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
        oldTime,
        task.id,
      ]);

      const findings = await codeLevelTriage();

      expect(findings.reclaimedTasks.length).toBe(1);
      expect(findings.reclaimedTasks[0]!.taskId).toBe(task.id);
      expect(findings.reclaimedTasks[0]!.outcome).toBe("requeued");
      expect(findings.stalledTasks.length).toBe(0);

      // Task is requeued (not failed) and the dead session is cleaned up.
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("unassigned");
      expect(updated?.agentId).toBeNull();
      expect(getAgentById(agent.id)?.status).toBe("offline");

      const session = getActiveSessionForTask(task.id);
      expect(session).toBeNull();
    });

    test("escalates stalled task with fresh session heartbeat (ambiguous)", async () => {
      const agent = createAgent({ name: "alive-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: agent.id });
      startTask(task.id);

      // Create an active session with fresh heartbeat
      insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });

      // Make task stale (45 min — past the 30 min threshold) but keep session fresh
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);
      // Session lastHeartbeatAt stays current (just created)

      const findings = await codeLevelTriage();

      expect(findings.autoFailedTasks.length).toBe(0);
      expect(findings.stalledTasks.length).toBe(1);
      expect(findings.stalledTasks[0]!.id).toBe(task.id);
      // Task should NOT be failed
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("in_progress");
    });

    test("auto-assigns pool tasks to idle workers", async () => {
      const worker = createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createTaskExtended("Pool task 1");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(worker.id);

      // Verify task is now in_progress
      const task = getTaskById(findings.autoAssigned[0]!.taskId);
      expect(task?.status).toBe("in_progress");
      expect(task?.agentId).toBe(worker.id);
    });

    test("auto-assignment skips lead agents", async () => {
      createAgent({ name: "idle-lead", isLead: true, status: "idle" });
      createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("auto-assignment skips offline workers", async () => {
      createAgent({ name: "offline-worker", isLead: false, status: "offline" });
      createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("auto-assignment respects worker capacity", async () => {
      const worker = createAgent({ name: "full-worker", isLead: false, status: "idle" });
      // maxTasks defaults to 1 — fill capacity
      const existingTask = createTaskExtended("Existing task", { agentId: worker.id });
      startTask(existingTask.id);

      createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("fixes worker with busy status but no active tasks", async () => {
      createAgent({ name: "ghost-busy", isLead: false, status: "busy" });

      const findings = await codeLevelTriage();
      expect(findings.workerHealthFixes.length).toBe(1);
      expect(findings.workerHealthFixes[0]!.oldStatus).toBe("busy");
      expect(findings.workerHealthFixes[0]!.newStatus).toBe("idle");
    });

    test("fixes worker with idle status but active tasks", async () => {
      const worker = createAgent({ name: "ghost-idle", isLead: false, status: "idle" });
      const task = createTaskExtended("Active task", { agentId: worker.id });
      startTask(task.id);
      // Force status back to idle (simulate race)
      updateAgentStatus(worker.id, "idle");

      const findings = await codeLevelTriage();
      expect(
        findings.workerHealthFixes.some((f) => f.oldStatus === "idle" && f.newStatus === "busy"),
      ).toBe(true);
    });

    test("no stalled tasks when workers are healthy", async () => {
      createAgent({ name: "healthy-worker", isLead: false, status: "idle" });

      const findings = await codeLevelTriage();
      expect(findings.stalledTasks.length).toBe(0);
    });

    test("takes a dead worker offline after reclaiming its only task", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: agent.id });
      startTask(task.id);

      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      await codeLevelTriage();

      // Not idle: we just proved this worker's process is gone, so it must not be
      // eligible for auto-assignment. It clears 'offline' by re-registering.
      const agents = getDb().query("SELECT status FROM agents WHERE id = ?").get(agent.id) as {
        status: string;
      };
      expect(agents.status).toBe("offline");
    });
  });

  // ==========================================================================
  // Full Sweep
  // ==========================================================================

  describe("runHeartbeatSweep", () => {
    test("bails early when gate returns false (empty state)", async () => {
      // No tasks, no agents — gate should bail
      // Should not throw
      await runHeartbeatSweep();
    });

    test("runs full triage when gate detects issues", async () => {
      const worker = createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createAgent({ name: "lead", isLead: true, status: "idle" });
      createTaskExtended("Pool task");

      await runHeartbeatSweep();

      // Verify task was auto-assigned
      const tasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE status = 'in_progress' AND agentId = ?")
        .all(worker.id) as Array<{ id: string }>;
      expect(tasks.length).toBe(1);
    });

    test("requeues stalled task with no session during sweep", async () => {
      const worker = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled no-session", { agentId: worker.id });
      startTask(task.id);

      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      await runHeartbeatSweep();

      // Requeued rather than failed, and NOT auto-assigned back to the worker
      // we just established is dead.
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("unassigned");
      expect(updated?.agentId).toBeNull();
      expect(getAgentById(worker.id)?.status).toBe("offline");
    });

    test("a reclaimed task is handed to a live worker, not the dead one", async () => {
      const dead = createAgent({ name: "dead-worker-2", isLead: false, status: "busy" });
      const alive = createAgent({ name: "live-worker", isLead: false, status: "idle" });
      const task = createTaskExtended("Work that must survive", { agentId: dead.id });
      startTask(task.id);

      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      await runHeartbeatSweep();

      // The sweep reclaims from the dead worker and auto-assigns to the live one
      // in the same pass, so the work keeps moving without a wasted attempt.
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("in_progress");
      expect(updated?.agentId).toBe(alive.id);
      expect(getAgentById(dead.id)?.status).toBe("offline");
    });

    test("cleans stale sessions even when preflight gate bails", async () => {
      const worker = createAgent({ name: "worker", isLead: false, status: "offline" });
      const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      getDb().run(
        `INSERT INTO active_sessions (id, agentId, triggerType, startedAt, lastHeartbeatAt)
         VALUES (?, ?, 'manual', ?, ?)`,
        ["test-stale-session", worker.id, staleTime, staleTime],
      );

      await runHeartbeatSweep();

      const remaining = getDb()
        .query("SELECT COUNT(*) as count FROM active_sessions WHERE id = ?")
        .get("test-stale-session") as { count: number };
      expect(remaining.count).toBe(0);
    });
  });

  // ==========================================================================
  // Reboot Sweep
  // ==========================================================================

  describe("Reboot Sweep", () => {
    test("no-op when no in_progress tasks exist", async () => {
      await runRebootSweep();

      const affected = getRebootAffectedTasks();
      expect(affected.length).toBe(0);
    });

    test("requeues an interrupted task under its original id", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Interrupted task", { agentId: agent.id });
      startTask(task.id);

      // Backdate so getStalledInProgressTasks(0) picks it up (avoids same-ms timing issue)
      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      // A restart is not a task failure. The task goes back to the pool keeping
      // its identity, so its attempt count still bounds it.
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("unassigned");
      expect(updated?.agentId).toBeNull();

      const affected = getRebootAffectedTasks();
      expect(affected.length).toBe(1);
      expect(affected[0]!.original.id).toBe(task.id);
      expect(affected[0]!.outcome).toBe("requeued");

      // No clone is created — that was the old behaviour and it reset the budget.
      const clones = getDb().query("SELECT * FROM agent_tasks WHERE parentTaskId = ?").all(task.id);
      expect(clones.length).toBe(0);
    });

    test("dead-letters an interrupted task whose retry budget is spent", async () => {
      const agent = createAgent({ name: "dead-worker-budget", isLead: false, status: "busy" });
      const task = createTaskExtended("Task that keeps killing the server", { agentId: agent.id });
      startTask(task.id);

      // Simulate a task that has already burned its budget across earlier boots.
      getDb().run("UPDATE agent_tasks SET attempts = maxAttempts, lastUpdatedAt = ? WHERE id = ?", [
        new Date(Date.now() - 1000).toISOString(),
        task.id,
      ]);

      await runRebootSweep();

      // The whole point of preserving identity: a task that crashes the server
      // every boot terminates instead of looping forever under a fresh id.
      expect(getTaskById(task.id)?.status).toBe("dead_letter");
      expect(getRebootAffectedTasks()[0]!.outcome).toBe("dead_lettered");
    });

    test("skips in_progress task that has an active session", async () => {
      const agent = createAgent({ name: "alive-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Active task", { agentId: agent.id });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      // Create an active session — worker is still alive
      insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });

      await runRebootSweep();

      // Task should NOT be failed
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("in_progress");

      // No retry tasks should exist for this task
      const retries = getDb()
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(0);
    });

    test("retry dedup: does not create second retry when one already exists", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Interrupted task", { agentId: agent.id });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      // Pre-create a retry task (simulating a previous reboot sweep)
      createTaskExtended("Retry of interrupted task", { parentTaskId: task.id });

      await runRebootSweep();

      // Should only have the one pre-existing retry, not a second
      const retries = getDb()
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(1);
    });

    test("does not retry system tasks (heartbeat-checklist)", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
      const task = createTaskExtended("Heartbeat check", {
        agentId: lead.id,
        taskType: "heartbeat-checklist",
      });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      // Task should be failed
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("failed");

      // But no retry should be created
      const retries = getDb()
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(0);

      // Affected list should show null retryTaskId
      const affected = getRebootAffectedTasks();
      expect(affected.length).toBe(1);
      expect(affected[0]!.retryTaskId).toBeNull();
    });

    test("does not retry system tasks (boot-triage)", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
      const task = createTaskExtended("Boot triage", {
        agentId: lead.id,
        taskType: "boot-triage",
      });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("failed");

      const retries = getDb()
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(0);
    });

    test("does not retry system tasks (heartbeat)", async () => {
      const agent = createAgent({ name: "worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Heartbeat task", {
        agentId: agent.id,
        taskType: "heartbeat",
      });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("failed");

      const retries = getDb()
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(0);
    });

    test("takes the dead worker offline after reclaiming its only task", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Interrupted task", { agentId: agent.id });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      // Not idle: the server just restarted, so this worker process is gone.
      // Idle would make it eligible for auto-assignment again.
      const agentRow = getDb().query("SELECT status FROM agents WHERE id = ?").get(agent.id) as {
        status: string;
      };
      expect(agentRow.status).toBe("offline");
    });

    test("concurrent calls only process tasks once (dedup guard)", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Interrupted task", { agentId: agent.id });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      // Run two sweeps concurrently
      await Promise.all([runRebootSweep(), runRebootSweep()]);

      // The task must be reclaimed exactly once. startTask spent one attempt when
      // work began; a second reclaim would burn another for a single restart and
      // bring dead_letter closer.
      const updated = getTaskById(task.id);
      expect(updated?.status).toBe("unassigned");
      expect(updated?.attempts).toBe(1);

      const clones = getDb().query("SELECT * FROM agent_tasks WHERE parentTaskId = ?").all(task.id);
      expect(clones.length).toBe(0);
    });

    test("preserves task metadata across the restart", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("High priority task", {
        agentId: agent.id,
        priority: 90,
        source: "slack",
        slackChannelId: "C123",
        slackThreadTs: "1700000000.000100",
      });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      // Keeping the row means metadata survives for free. The old clone copied
      // priority and source but dropped the Slack thread, so the reply from the
      // retry landed nowhere.
      const requeued = getTaskById(task.id);
      expect(requeued!.priority).toBe(90);
      expect(requeued!.source).toBe("slack");
      expect(requeued!.slackChannelId).toBe("C123");
      expect(requeued!.slackThreadTs).toBe("1700000000.000100");
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe("Start/Stop Lifecycle", () => {
    test("startHeartbeat and stopHeartbeat work without errors", () => {
      startHeartbeat(60000);
      // Should not throw when called again
      startHeartbeat(60000);
      stopHeartbeat();
      // Should not throw when called again
      stopHeartbeat();
    });
  });
});
