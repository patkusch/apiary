/**
 * End-to-end check of the dead-letter flow against a real API server.
 *
 * Unit tests put a task into dead_letter by writing to the database. This
 * starts `bun src/http.ts` as its own process and drives it only over HTTP, so
 * the pieces have to work together: a worker claims through /api/poll, stops
 * renewing, and the server's own heartbeat reaps the lease until the retry
 * budget runs out. Then it requeues the task with the same request the
 * dashboard's Requeue button sends, and checks that a worker gets it again.
 * It also checks that the heartbeat times out a standalone approval request.
 *
 * Usage: bun run e2e:dead-letter
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";

const PORT = Number(process.env.E2E_PORT) || 3919;
const BASE = `http://localhost:${PORT}`;
const API_KEY = "e2e-dead-letter";
const WORKER_ID = crypto.randomUUID();

type Task = {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  failureReason?: string;
};

function step(message: string): void {
  console.log(`✓ ${message}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function api(path: string, init: RequestInit = {}, agentId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  if (agentId) headers["X-Agent-ID"] = agentId;
  return fetch(`${BASE}${path}`, { ...init, headers });
}

async function getTask(id: string): Promise<Task> {
  const res = await api(`/api/tasks/${id}`);
  check(res.ok, `GET /api/tasks/${id} returned ${res.status}`);
  return (await res.json()) as Task;
}

/** Poll until `probe` returns a value, or fail after `timeoutMs`. */
async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(300);
  }
  throw new Error(`FAILED: timed out waiting for ${what}`);
}

async function run(): Promise<void> {
  await waitFor("the API server to start", async () => {
    const res = await fetch(`${BASE}/health`).catch(() => null);
    return res?.ok ? true : undefined;
  });
  step("API server is up");

  const registered = await api(
    "/api/agents",
    { method: "POST", body: JSON.stringify({ name: "e2e-crashing-worker" }) },
    WORKER_ID,
  );
  check(registered.ok, `worker registration returned ${registered.status}`);

  const created = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ task: "e2e: a task whose worker keeps dying" }),
  });
  check(created.ok, `task creation returned ${created.status}`);
  const createdBody = (await created.json()) as { id?: string; task?: { id: string } };
  const taskId = createdBody.id ?? createdBody.task?.id;
  check(taskId, "task creation returned no id");
  step(`task ${taskId.slice(0, 8)} created in the pool`);

  // The worker claims whenever the task is back in the pool, then goes silent
  // and never renews, which is exactly what the server sees when a worker dies.
  const parked = await waitFor("the heartbeat to dead-letter the task", async () => {
    const task = await getTask(taskId);
    if (task.status === "dead_letter") return task;
    if (task.status === "unassigned") await api("/api/poll", {}, WORKER_ID);
    return undefined;
  });
  check(parked.attempts === parked.maxAttempts, "dead-lettered before the budget was spent");
  check(parked.failureReason?.startsWith("Dead-lettered"), "no dead-letter failure reason");
  step(`heartbeat dead-lettered it after ${parked.attempts} of ${parked.maxAttempts} attempts`);

  const listed = (await (await api("/api/dead-letter-tasks")).json()) as { tasks: Task[] };
  check(
    listed.tasks.some((t) => t.id === taskId),
    "task missing from GET /api/dead-letter-tasks",
  );
  const filtered = (await (await api("/api/tasks?status=dead_letter")).json()) as {
    tasks: Task[];
  };
  check(
    filtered.tasks.some((t) => t.id === taskId),
    "task missing from the dashboard's dead_letter filter",
  );
  step("listed by GET /api/dead-letter-tasks and by the dashboard's status filter");

  // Same request as ui/src/api/client.ts requeueTask() with no extraAttempts.
  const requeued = await api(`/api/tasks/${taskId}/requeue`, { method: "POST", body: "{}" });
  check(requeued.status === 200, `requeue returned ${requeued.status}`);
  const afterRequeue = ((await requeued.json()) as { task: Task }).task;
  check(afterRequeue.status === "unassigned", `requeue left status ${afterRequeue.status}`);
  check(afterRequeue.maxAttempts > parked.attempts, "requeue did not grant a fresh budget");
  const relisted = (await (await api("/api/dead-letter-tasks")).json()) as { tasks: Task[] };
  check(!relisted.tasks.some((t) => t.id === taskId), "task still listed as dead-lettered");
  step(`requeued: back in the pool with ${afterRequeue.maxAttempts} attempts allowed`);

  const reclaimed = await waitFor("a worker to pick the requeued task up", async () => {
    const task = await getTask(taskId);
    if (task.attempts > parked.attempts && task.status !== "dead_letter") return task;
    if (task.status === "unassigned") await api("/api/poll", {}, WORKER_ID);
    return undefined;
  });
  step(`claimed again (attempt ${reclaimed.attempts}), so the requeue really returned it`);

  const approval = await api("/api/approval-requests", {
    method: "POST",
    body: JSON.stringify({
      title: "e2e: nobody answers this",
      questions: [{ id: "q1", type: "approval", label: "Approve?" }],
      approvers: { policy: "any" },
      timeoutSeconds: 1,
    }),
  });
  check(approval.status === 201, `approval creation returned ${approval.status}`);
  const approvalId = ((await approval.json()) as { approvalRequest: { id: string } })
    .approvalRequest.id;
  const timedOut = await waitFor("the heartbeat to time out the approval", async () => {
    const res = await api(`/api/approval-requests/${approvalId}`);
    const body = (await res.json()) as { approvalRequest: { status: string; resolvedBy: string } };
    return body.approvalRequest.status === "pending" ? undefined : body.approvalRequest;
  });
  check(timedOut.status === "timeout", `approval ended as ${timedOut.status}`);
  check(timedOut.resolvedBy === "heartbeat", `approval resolved by ${timedOut.resolvedBy}`);
  const late = await api(`/api/approval-requests/${approvalId}/respond`, {
    method: "POST",
    body: JSON.stringify({ responses: { q1: { approved: true } } }),
  });
  check(late.status === 409, `a late answer returned ${late.status}, expected 409`);
  step("heartbeat timed out a standalone approval request, and a late answer was refused");
}

const workDir = mkdtempSync(join(tmpdir(), "apiary-e2e-dead-letter-"));
let server: Subprocess | undefined;
let exitCode = 0;
try {
  server = spawn(["bun", "src/http.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      API_KEY,
      DATABASE_PATH: join(workDir, "e2e.sqlite"),
      TASK_LEASE_DURATION_MS: "1500",
      HEARTBEAT_INTERVAL_MS: "1000",
      HEARTBEAT_CHECKLIST_DISABLE: "1",
      OAUTH_KEEPALIVE_DISABLE: "true",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await run();
  console.log("\nDead-letter flow passed end to end.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  server?.kill();
  await server?.exited;
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
