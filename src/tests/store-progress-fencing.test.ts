// Lease fencing on the MCP path. A worker whose lease lapsed must not be able to
// finish, fail, or write progress on a task that was requeued or re-claimed by
// someone else — the same rule the HTTP finish endpoint already enforced.
//
// Drives the real `store-progress` handler by registering it on an McpServer
// and calling the registered handler the way the SDK would.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskById,
  initDb,
  reclaimExpiredTaskLeases,
  TASK_LEASE_DURATION_MS,
} from "../be/db";
import { registerStoreProgressTool } from "../tools/store-progress";

const TEST_DB_PATH = "./test-store-progress-fencing.sqlite";

type Args = {
  taskId: string;
  progress?: string;
  status?: "completed" | "failed";
  output?: string;
  failureReason?: string;
};
type Structured = { success: boolean; message: string; wasNoOp?: boolean };

let call: (args: Args, agentId: string) => Promise<Structured>;
let agentA: string;
let agentB: string;

function expireLease(taskId: string): void {
  const expired = new Date(Date.now() - TASK_LEASE_DURATION_MS - 1000).toISOString();
  getDb().prepare("UPDATE agent_tasks SET leaseExpiresAt = ? WHERE id = ?").run(expired, taskId);
}

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  initDb(TEST_DB_PATH);

  const server = new McpServer({ name: "fencing-test", version: "0.0.0" });
  registerStoreProgressTool(server);
  const tools = (server as unknown as Record<string, unknown>)._registeredTools as Record<
    string,
    { handler: (args: Args, extra: unknown) => Promise<{ structuredContent: Structured }> }
  >;
  const handler = tools["store-progress"].handler;
  call = async (args, agentId) => {
    const result = await handler(args, {
      sessionId: "s",
      requestInfo: { headers: { "x-agent-id": agentId } },
    });
    return result.structuredContent;
  };
});

beforeEach(() => {
  getDb().run("DELETE FROM agent_tasks");
  agentA = createAgent({ name: `a-${crypto.randomUUID()}`, isLead: false, status: "idle" }).id;
  agentB = createAgent({ name: `b-${crypto.randomUUID()}`, isLead: false, status: "idle" }).id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

describe("store-progress refuses a worker whose lease was reclaimed", () => {
  test("the owner can report on its own task", async () => {
    const task = createTaskExtended("mine");
    claimTask(task.id, agentA);
    expect((await call({ taskId: task.id, progress: "halfway" }, agentA)).success).toBe(true);
    const done = await call({ taskId: task.id, status: "completed", output: "done" }, agentA);
    expect(done.success).toBe(true);
    expect(getTaskById(task.id)?.status).toBe("completed");
  });

  test("after the lease lapses and the task is requeued, the stale worker cannot finish it", async () => {
    const task = createTaskExtended("requeued");
    claimTask(task.id, agentA);
    expireLease(task.id);
    reclaimExpiredTaskLeases();
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    const res = await call(
      { taskId: task.id, status: "completed", output: "stale result" },
      agentA,
    );
    expect(res.success).toBe(false);
    expect(res.message).toContain("not assigned to any agent");
    const after = getTaskById(task.id)!;
    expect(after.status).toBe("unassigned");
    expect(after.output).toBeUndefined();
  });

  test("once another worker holds the task, the stale worker cannot write over it", async () => {
    const task = createTaskExtended("re-claimed");
    claimTask(task.id, agentA);
    expireLease(task.id);
    reclaimExpiredTaskLeases();
    expect(claimTask(task.id, agentB)).not.toBeNull();

    const finish = await call(
      { taskId: task.id, status: "failed", failureReason: "stale" },
      agentA,
    );
    expect(finish.success).toBe(false);
    expect(finish.message).toContain(`assigned to agent "${agentB}"`);
    const progress = await call({ taskId: task.id, progress: "stale progress" }, agentA);
    expect(progress.success).toBe(false);

    const after = getTaskById(task.id)!;
    expect(after.status).toBe("in_progress");
    expect(after.agentId).toBe(agentB);
    expect(after.progress).toBeUndefined();

    // The rightful owner is unaffected.
    const ok = await call({ taskId: task.id, status: "completed", output: "real result" }, agentB);
    expect(ok.success).toBe(true);
    expect(getTaskById(task.id)?.output).toBe("real result");
  });

  test("a terminal task stays first-call-wins: the stale worker gets a no-op, not a write", async () => {
    const task = createTaskExtended("finished by B");
    claimTask(task.id, agentA);
    expireLease(task.id);
    reclaimExpiredTaskLeases();
    claimTask(task.id, agentB);
    await call({ taskId: task.id, status: "completed", output: "B's output" }, agentB);

    const res = await call({ taskId: task.id, status: "completed", output: "A's output" }, agentA);
    expect(res.wasNoOp).toBe(true);
    expect(getTaskById(task.id)?.output).toBe("B's output");
  });
});
