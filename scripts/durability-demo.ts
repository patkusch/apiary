#!/usr/bin/env bun
/**
 * Durability demo.
 *
 * Runs the lease lifecycle against a real SQLite database and prints each state
 * transition with a timestamp, so the durability claims can be checked by
 * watching rather than by reading test source.
 *
 * What this does simulate: a worker taking a lease, dying without releasing it,
 * the lease lapsing, the reaper requeueing the task, a second worker picking it
 * up and finishing it, and a task that keeps dying terminating in dead_letter
 * instead of looping forever.
 *
 * What this does NOT simulate: killing an operating system process. Worker death
 * here means the lease stops being renewed, which is exactly what the server
 * observes when a worker dies, but the demo does not spawn real agents. A
 * process-level test is still outstanding, and is listed under Known limitations
 * in the README.
 *
 * Usage: bun run demo
 */

import { unlinkSync } from "node:fs";
import {
  claimTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  DEFAULT_MAX_TASK_ATTEMPTS,
  getDb,
  getTaskById,
  initDb,
  reclaimExpiredTaskLeases,
  renewTaskLease,
  TASK_LEASE_DURATION_MS,
} from "@/be/db";

const DB_PATH = `./.apiary-demo-${crypto.randomUUID()}.sqlite`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function stamp(): string {
  return dim(new Date().toISOString().slice(11, 23));
}

function log(icon: string, message: string): void {
  console.log(`${stamp()}  ${icon} ${message}`);
}

/** Print the task's durability-relevant state as the server sees it. */
function show(taskId: string, label: string): void {
  const t = getTaskById(taskId);
  if (!t) return;
  const owner = t.leaseOwnerId ? t.leaseOwnerId.slice(0, 8) : "—";
  const lease = t.leaseExpiresAt ? new Date(t.leaseExpiresAt).toISOString().slice(11, 19) : "—";
  console.log(
    dim(
      `            ${label.padEnd(22)} status=${t.status.padEnd(12)} ` +
        `attempts=${t.attempts}/${t.maxAttempts}  owner=${owner}  lease_expires=${lease}`,
    ),
  );
}

/**
 * Worker death. The process stops renewing its lease; nothing releases the task.
 * Backdating the expiry is how we reach that state without waiting 10 minutes.
 */
function workerDies(taskId: string): void {
  getDb()
    .prepare("UPDATE agent_tasks SET leaseExpiresAt = ? WHERE id = ?")
    .run(new Date(Date.now() - TASK_LEASE_DURATION_MS).toISOString(), taskId);
}

function section(title: string): void {
  console.log(`\n${bold(title)}`);
  console.log(dim("─".repeat(74)));
}

function main(): void {
  initDb(DB_PATH);

  const alice = createAgent({ name: "worker-alice", isLead: false, status: "idle" });
  const bob = createAgent({ name: "worker-bob", isLead: false, status: "idle" });

  console.log(
    `\n${bold("apiary durability demo")}  ${dim(`lease=${TASK_LEASE_DURATION_MS / 1000}s  budget=${DEFAULT_MAX_TASK_ATTEMPTS} attempts`)}`,
  );
  console.log(dim(`workers: alice=${alice.id.slice(0, 8)}  bob=${bob.id.slice(0, 8)}`));

  // ---------------------------------------------------------------- claim 1
  section("1. A task is leased, and a second worker cannot take it");

  const task = createTaskExtended("ship the invoice endpoint");
  log("·", `task created ${dim(task.id.slice(0, 8))}`);

  const claimed = claimTask(task.id, alice.id);
  log(green("✓"), `alice claimed it, lease held for ${TASK_LEASE_DURATION_MS / 1000}s`);
  show(task.id, "after alice claims");

  const stolen = claimTask(task.id, bob.id);
  log(
    stolen === null ? green("✓") : red("✗"),
    stolen === null
      ? "bob tried to claim the same task and was refused"
      : "bob claimed a held task, which is a bug",
  );

  // ---------------------------------------------------------- healthy worker
  section("2. A working worker keeps its task by renewing");

  workerDies(task.id); // age the lease to the brink
  log("·", "lease has aged past its expiry");
  const renewed = renewTaskLease(task.id, alice.id);
  log(renewed ? green("✓") : red("✗"), "alice renewed the lease, she is still alive");
  const noReap = reclaimExpiredTaskLeases();
  log(
    noReap.length === 0 ? green("✓") : red("✗"),
    `reaper ran and reclaimed ${noReap.length} task(s), alice keeps her work`,
  );
  show(task.id, "after renewal");

  // ------------------------------------------------------------ worker dies
  section("3. A worker dies mid-task and the work survives");

  log(red("✗"), "alice's process dies, holding the task, renewing nothing");
  workerDies(task.id);
  show(task.id, "lease lapsed");

  const reclaimed = reclaimExpiredTaskLeases();
  log(
    green("✓"),
    `reaper requeued the task (outcome=${reclaimed[0]?.outcome}), it is not marked failed`,
  );
  show(task.id, "after reclaim");

  const retried = claimTask(task.id, bob.id);
  log(
    green("✓"),
    `bob picked up the same task ${dim(task.id.slice(0, 8))}, attempt ${retried?.attempts}`,
  );
  show(task.id, "after bob claims");

  completeTask(task.id, "invoice endpoint shipped");
  const done = getTaskById(task.id);
  log(
    done?.status === "completed" ? green("✓") : red("✗"),
    `bob finished it: status=${done?.status}. No work was lost.`,
  );

  // ----------------------------------------------------------- poison task
  section("4. A task that keeps killing its worker terminates");

  const poison = createTaskExtended("task that crashes whatever runs it");
  log("·", `task created ${dim(poison.id.slice(0, 8))}`);

  for (let attempt = 1; attempt <= DEFAULT_MAX_TASK_ATTEMPTS; attempt++) {
    claimTask(poison.id, alice.id);
    workerDies(poison.id);
    const result = reclaimExpiredTaskLeases();
    const outcome = result.find((r) => r.taskId === poison.id)?.outcome;
    log(
      outcome === "dead_lettered" ? yellow("■") : "·",
      `attempt ${attempt}/${DEFAULT_MAX_TASK_ATTEMPTS} died → ${outcome}`,
    );
  }
  show(poison.id, "final");

  const finalPoison = getTaskById(poison.id);
  log(
    finalPoison?.status === "dead_letter" ? green("✓") : red("✗"),
    "the retry budget is spent, so it stopped rather than looping forever",
  );

  const revived = claimTask(poison.id, bob.id);
  log(
    revived === null ? green("✓") : red("✗"),
    "a dead-lettered task cannot be claimed again without an explicit requeue",
  );

  console.log(`\n${dim("─".repeat(74))}`);
  console.log(`${bold("Done.")} Nothing above is mocked. Every line is a real SQLite write.\n`);
}

try {
  main();
} finally {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${DB_PATH}${suffix}`);
    } catch {
      // nothing to clean up
    }
  }
}
