/**
 * Task lifecycle hooks.
 *
 * The persistence layer must not reach out to the network. Upstream, `claimTask`
 * imported `../github/task-reactions` and fired an HTTP request to GitHub from
 * inside a SQLite write path, which meant the data layer depended on Slack and
 * GitHub and could not be exercised without mocking the internet.
 *
 * Instead, db.ts emits through this tiny in-process registry and integrations
 * subscribe at startup (see `src/be/wiring.ts`). Listeners are fire-and-forget:
 * a listener that throws or rejects can never fail the database operation that
 * triggered it.
 */

import type { AgentTask } from "../types.ts";

export type TaskStartedListener = (task: AgentTask) => void | Promise<void>;

const taskStartedListeners: TaskStartedListener[] = [];

/** Subscribe to "a worker has started this task". Returns an unsubscribe fn. */
export function onTaskStarted(listener: TaskStartedListener): () => void {
  taskStartedListeners.push(listener);
  return () => {
    const i = taskStartedListeners.indexOf(listener);
    if (i >= 0) taskStartedListeners.splice(i, 1);
  };
}

/** Fire-and-forget notification. Never throws, never blocks the caller. */
export function emitTaskStarted(task: AgentTask): void {
  for (const listener of taskStartedListeners) {
    try {
      Promise.resolve(listener(task)).catch(() => {});
    } catch {
      // A listener must never break the write that triggered it.
    }
  }
}

/** Test helper — drops all listeners so suites don't leak into each other. */
export function resetTaskHooks(): void {
  taskStartedListeners.length = 0;
}
