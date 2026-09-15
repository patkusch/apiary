/**
 * The task page shows why a task stopped in a card, and renders that card in
 * two layouts. Only one of them said "Dead-lettered" for a dead_letter task;
 * the layout the dashboard actually shows still said "Failure Reason". Found
 * by opening a live dead-lettered task in the dashboard.
 *
 * `ui/` has no test runner, so this follows use-dismissible-card.test.ts:
 * import the pure helper from the UI source, and read the page source to make
 * sure no layout hard-codes the heading again.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { failureSectionTitle } from "../../ui/src/lib/status-tone.ts";

describe("failureSectionTitle", () => {
  test("names a dead-lettered task as dead-lettered", () => {
    expect(failureSectionTitle("dead_letter")).toBe("Dead-lettered");
  });

  test("keeps the plain heading for an ordinary failure", () => {
    expect(failureSectionTitle("failed")).toBe("Failure Reason");
    expect(failureSectionTitle(undefined)).toBe("Failure Reason");
  });
});

describe("task page", () => {
  const page = readFileSync(
    new URL("../../ui/src/pages/tasks/[id]/page.tsx", import.meta.url),
    "utf8",
  );

  test("every failure card takes its heading from the helper", () => {
    expect(page).not.toContain('title="Failure Reason"');
    const uses = page.match(/title=\{failureSectionTitle\(task\.status\)\}/g) ?? [];
    expect(uses.length).toBe(2);
  });
});
