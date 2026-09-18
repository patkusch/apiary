/**
 * Drives the built dashboard in headless Chromium through the dead-letter
 * flow: a task parked by the real server's heartbeat is found with the status
 * filter, its page says "Dead-lettered", and the Requeue button, after its
 * confirmation, puts it back in the pool. The API is asked at the end, so the
 * page and the server have to agree.
 *
 * scripts/e2e-dead-letter.ts covers the same flow over HTTP only; this is the
 * part that clicks the button.
 *
 * Usage: bun run e2e:dashboard
 */

import { expect, type Page, test } from "@playwright/test";
import { API_KEY, API_URL, api, DASHBOARD_URL, getTask, startStack, waitFor } from "./stack";

const TASK_TEXT = "e2e: a task whose worker keeps dying (seen from the dashboard)";
const WORKER_ID = crypto.randomUUID();

let stop: () => Promise<void>;
test.beforeAll(async () => {
  ({ stop } = await startStack());
});
test.afterAll(async () => {
  await stop?.();
});

/** Everything the browser reports going wrong while the flow runs. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`uncaught error: ${error.message}`));
  page.on("requestfailed", (request) => {
    // The dashboard refetches every few seconds, so a navigation cancels
    // whatever request was in flight. That is not a failure.
    if (request.failure()?.errorText === "net::ERR_ABORTED") return;
    problems.push(`request failed: ${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
  return problems;
}

/** Register a worker, create a task, and let the heartbeat dead-letter it. */
async function parkATask(): Promise<{ id: string; attempts: number; maxAttempts: number }> {
  const registered = await api(
    "/api/agents",
    { method: "POST", body: JSON.stringify({ name: "e2e-crashing-worker" }) },
    WORKER_ID,
  );
  expect(registered.ok).toBe(true);

  const created = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ task: TASK_TEXT }),
  });
  expect(created.ok).toBe(true);
  const body = (await created.json()) as { id?: string; task?: { id: string } };
  const id = body.id ?? body.task?.id;
  expect(id).toBeTruthy();

  // The worker claims whenever the task is back in the pool, then goes silent
  // and never renews: what the server sees when a worker dies.
  const parked = await waitFor("the heartbeat to dead-letter the task", async () => {
    const task = await getTask(id as string);
    if (task.status === "dead_letter") return task;
    if (task.status === "unassigned") await api("/api/poll", {}, WORKER_ID);
    return undefined;
  });
  return { id: parked.id, attempts: parked.attempts, maxAttempts: parked.maxAttempts };
}

test("the dashboard's Requeue button takes a dead-lettered task back to the pool", async ({
  page,
}) => {
  const task = await parkATask();
  expect(task.attempts).toBe(task.maxAttempts);

  // Point the dashboard at the test server, the way the config page would.
  await page.addInitScript(
    ([apiUrl, apiKey]) => {
      const key = "agent-swarm-connections";
      if (localStorage.getItem(key)) return;
      const connection = { id: "conn_e2e", name: "e2e", apiUrl, apiKey };
      localStorage.setItem(
        key,
        JSON.stringify({ connections: [connection], activeId: connection.id }),
      );
    },
    [API_URL, API_KEY],
  );
  const problems = watchForProblems(page);

  await test.step("filter the task list to dead-letter", async () => {
    await page.goto(`${DASHBOARD_URL}/tasks`);
    await page.getByRole("combobox").filter({ hasText: "All Statuses" }).click();
    await page.getByRole("option", { name: "Dead letter" }).click();
    await expect(page).toHaveURL(/status=dead_letter/);
    await expect(page.getByRole("row").filter({ hasText: TASK_TEXT })).toBeVisible();
  });

  await test.step("the task page says Dead-lettered, in both layouts", async () => {
    await page.getByRole("row").filter({ hasText: TASK_TEXT }).getByText(TASK_TEXT).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
    // The page holds a wide and a narrow layout and hides one with CSS, so
    // look only at whichever is showing.
    const heading = page.getByText("Dead-lettered", { exact: true }).locator("visible=true");
    const oldHeading = page.getByText("Failure Reason", { exact: true }).locator("visible=true");
    await expect(heading).toBeVisible();
    await expect(oldHeading).toHaveCount(0);

    // On a phone the same card sits under the Outcome tab.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Outcome" }).click();
    await expect(heading).toBeVisible();
    await expect(oldHeading).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  await test.step("Requeue asks first, and says how many attempts were used", async () => {
    await page
      .getByRole("button", { name: "Requeue", exact: true })
      .locator("visible=true")
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`${task.attempts} of ${task.maxAttempts} attempts`);
    await dialog.getByRole("button", { name: "Requeue Task" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("the page shows the task back in the pool", async () => {
    await expect(
      page.getByText("UNASSIGNED", { exact: true }).locator("visible=true"),
    ).toBeVisible();
    await expect(
      page.getByText("DEAD LETTER", { exact: true }).locator("visible=true"),
    ).toHaveCount(0);
  });

  await test.step("the dead-letter list no longer has the row", async () => {
    await page.goto(`${DASHBOARD_URL}/tasks?status=dead_letter`);
    await expect(page.getByText("No tasks found")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: TASK_TEXT })).toHaveCount(0);
  });

  await test.step("the API agrees", async () => {
    const after = await getTask(task.id);
    expect(after.status).toBe("unassigned");
    expect(after.maxAttempts).toBeGreaterThan(task.attempts);
    const listed = (await (await api("/api/dead-letter-tasks")).json()) as {
      tasks: { id: string }[];
    };
    expect(listed.tasks.map((t) => t.id)).not.toContain(task.id);
  });

  expect(problems, "the browser reported problems during the flow").toEqual([]);
});
