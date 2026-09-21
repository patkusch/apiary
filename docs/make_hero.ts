/**
 * Runs the real API server and the real dashboard through one short story,
 * prints what happened, and saves a 2x screenshot of the dashboard's
 * dead-letter list as docs/hero.png (the README's hero image).
 *
 * The story, with two stand-in workers that talk to the server over HTTP:
 *   1. worker-a takes a task and goes silent. The server notices, puts the
 *      task back in the pool, and worker-b finishes it.
 *   2. A second task kills every worker that touches it. After three tries
 *      it is parked in the dead-letter list.
 *   3. The screenshot is taken with that task waiting in the list.
 *   4. A person clicks Requeue in the dashboard, and the task goes back to
 *      the pool with a fresh budget.
 *
 * The task ids and timings differ on every run. The server is the same
 * process the e2e suite uses (e2e/dashboard/stack.ts), with the same short
 * settings: a worker silent for 1.5 seconds loses its task, and the server
 * checks once a second. The real defaults are 10 minutes and 90 seconds.
 *
 * Usage: bun docs/make_hero.ts
 * Needs Chromium once: npx playwright install chromium
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import {
  API_KEY,
  API_URL,
  api,
  DASHBOARD_URL,
  getTask,
  startStack,
  type Task,
  waitFor,
} from "../e2e/dashboard/stack";

const ROOT = join(import.meta.dir, "..");
const OUT = join(import.meta.dir, "hero.png");

const VIEW_W = 1600;
const VIEW_H = 470;
const HEADER_H = 57;

const started = Date.now();
const names = new Map<string, string>();

function stamp(): string {
  return `+${((Date.now() - started) / 1000).toFixed(1).padStart(4)}s`;
}

function say(message: string): void {
  console.log(`${stamp()}  ${message}`);
}

type Seen = Task & { agentId?: string | null; task: string };

function describe(t: Seen, previous?: Seen): string {
  const owner = t.agentId ? (names.get(t.agentId) ?? t.agentId.slice(0, 8)) : "nobody";
  const oldOwner = previous?.agentId ? names.get(previous.agentId) : undefined;
  const counts = `attempts ${t.attempts} of ${t.maxAttempts}`;
  if (t.status === "in_progress") return `in_progress   ${counts}  ${owner} has it`;
  if (t.status === "completed") return `completed     ${counts}  ${owner} finished it`;
  if (t.status === "dead_letter") {
    return `dead_letter   ${counts}  parked, waiting for a person`;
  }
  if (t.attempts === 0) return `unassigned    ${counts}  in the pool, nobody has it yet`;
  if (previous?.status === "dead_letter") {
    return `unassigned    ${counts}  a person requeued it, back in the pool with a fresh budget`;
  }
  const who = oldOwner ?? "the worker";
  return `unassigned    ${counts}  ${who} went quiet, so it went back to the pool`;
}

/** Print each change of status, attempts or owner until `done` says stop. */
async function follow(
  id: string,
  done: (t: Seen) => boolean,
  poll?: () => Promise<void>,
  from?: Seen,
) {
  let last: Seen | undefined = from;
  return waitFor(`task ${id.slice(0, 8)}`, async () => {
    const t = (await getTask(id)) as Seen;
    if (
      !last ||
      t.status !== last.status ||
      t.attempts !== last.attempts ||
      t.agentId !== last.agentId
    ) {
      say(describe(t, last));
      last = t;
    }
    if (done(t)) return t;
    if (poll) await poll();
    return undefined;
  });
}

async function register(name: string): Promise<string> {
  const id = crypto.randomUUID();
  const res = await api("/api/agents", { method: "POST", body: JSON.stringify({ name }) }, id);
  if (!res.ok) throw new Error(`registering ${name} returned ${res.status}`);
  names.set(id, name);
  return id;
}

async function createTask(text: string): Promise<string> {
  const res = await api("/api/tasks", { method: "POST", body: JSON.stringify({ task: text }) });
  const body = (await res.json()) as { id?: string; task?: { id: string } };
  const id = body.id ?? body.task?.id;
  if (!res.ok || !id) throw new Error(`creating a task returned ${res.status}`);
  return id;
}

async function main() {
  if (!existsSync(join(ROOT, "ui", "dist", "index.html"))) {
    console.log("Building the dashboard first (bun run build:dashboard)...");
    const built = spawnSync("bun", ["run", "build:dashboard"], { cwd: ROOT, stdio: "inherit" });
    if (built.status !== 0) throw new Error("the dashboard build failed");
  }

  const { stop } = await startStack();
  try {
    // The server hands a returned task to the first idle worker it finds, in
    // registration order. worker-b registers first so the task that worker-a
    // drops goes to worker-b.
    const b = await register("worker-b");
    const a = await register("worker-a");
    console.log(
      "A worker that stays silent for 1.5 seconds loses its task. The server checks once a second.\n",
    );

    // 1. A worker dies, and the task goes to another worker.
    const survivorText = "Rename the old config flag everywhere";
    const survivor = await createTask(survivorText);
    console.log(`task ${survivor.slice(0, 8)}  "${survivorText}"`);
    let handedOver = false;
    const finished = await follow(
      survivor,
      (t) => t.status === "completed",
      async () => {
        // worker-a asks for work once and then goes silent, like a crashed process.
        if (!handedOver) {
          await api("/api/poll", {}, a);
          handedOver = true;
        }
        const t = (await getTask(survivor)) as Seen;
        if (t.status === "in_progress" && t.agentId === b) {
          await api(
            `/api/tasks/${survivor}/finish`,
            {
              method: "POST",
              body: JSON.stringify({ status: "completed", output: "Renamed." }),
            },
            b,
          );
        }
      },
    );
    void finished;

    // 2. A task that kills every worker that takes it.
    const poisonText = "Regenerate the March invoices";
    const poison = await createTask(poisonText);
    console.log(`\ntask ${poison.slice(0, 8)}  "${poisonText}"`);
    let polled = false;
    const parked = await follow(
      poison,
      (t) => t.status === "dead_letter",
      async () => {
        if (!polled) {
          await api("/api/poll", {}, a);
          polled = true;
        }
      },
    );
    const listed = (await (await api("/api/dead-letter-tasks")).json()) as { tasks: Seen[] };
    say(
      `GET /api/dead-letter-tasks -> ${listed.tasks.length} task waiting: ${listed.tasks.map((t) => t.id.slice(0, 8)).join(", ")}`,
    );

    // 3. The screenshot, taken with the task waiting in the list.
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: VIEW_W, height: VIEW_H },
        deviceScaleFactor: 2,
      });
      await context.addInitScript(
        ([apiUrl, apiKey]) => {
          const connection = { id: "conn_hero", name: "apiary", apiUrl, apiKey };
          localStorage.setItem(
            "agent-swarm-connections",
            JSON.stringify({ connections: [connection], activeId: connection.id }),
          );
          localStorage.setItem("agent-swarm-mode", "dark");
        },
        [API_URL, API_KEY],
      );
      const page = await context.newPage();
      await page.goto(`${DASHBOARD_URL}/tasks?status=dead_letter`);
      await page.getByRole("row").filter({ hasText: poisonText }).waitFor();
      // The Status column is too narrow for "DEAD LETTER", so drag it wider
      // the way a person would.
      const drag = async (column: string, dx: number) => {
        const handle = page
          .locator(".ag-header-cell", { hasText: column })
          .locator(".ag-header-cell-resize");
        const box = await handle.boundingBox();
        if (!box) return;
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx, y, { steps: 8 });
        await page.mouse.up();
      };
      await drag("Status", 60);
      await page.waitForTimeout(800);
      // The top bar is left out: its dot shows this throwaway server has no AI
      // provider key set, which is true and has nothing to do with the story.
      await page.screenshot({
        path: OUT,
        clip: { x: 0, y: HEADER_H, width: VIEW_W, height: VIEW_H - HEADER_H },
      });
      const kb = Math.round(statSync(OUT).size / 1024);
      console.log(`\nSaved ${OUT} (${kb} KB, ${VIEW_W * 2} x ${(VIEW_H - HEADER_H) * 2})\n`);

      // 4. A person clicks Requeue.
      await page.getByRole("row").filter({ hasText: poisonText }).getByText(poisonText).click();
      await page
        .getByRole("button", { name: "Requeue", exact: true })
        .locator("visible=true")
        .click();
      const dialog = page.getByRole("alertdialog");
      const [title, question] = (await dialog.innerText()).split("\n").filter(Boolean);
      say(`dashboard asks "${title}": ${question}`);
      await dialog.getByRole("button", { name: "Requeue Task" }).click();
      await dialog.waitFor({ state: "hidden" });
    } finally {
      await browser.close();
    }
    const again = await follow(
      poison,
      (t) => t.status !== "dead_letter" && t.attempts > parked.attempts,
      undefined,
      parked as Seen,
    );
    void again;
  } finally {
    await stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
