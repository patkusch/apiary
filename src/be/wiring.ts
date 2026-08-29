/**
 * Integration wiring.
 *
 * Connects outbound integrations to task lifecycle hooks so that the
 * persistence layer stays free of network dependencies. Call `wireIntegrations()`
 * once during process startup, before serving traffic.
 */

import { addEyesReactionOnTaskStart } from "../github/task-reactions.ts";
import { onTaskStarted } from "./task-hooks.ts";

let wired = false;

export function wireIntegrations(): void {
  if (wired) return;
  wired = true;

  // Acknowledge VCS-sourced tasks with an 👀 reaction once a worker picks them up.
  onTaskStarted((task) => addEyesReactionOnTaskStart(task));
}
