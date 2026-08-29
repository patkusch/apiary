# Worker/Lead Spawn Trigger Changes Implementation Plan

## Overview

Modify the worker/lead spawning logic to:
1. Spawn workers on unassigned tasks (in addition to offered/assigned tasks)
2. Remove lead spawning on unassigned tasks
3. Add lead spawning on recently finished (completed/failed) worker tasks

## Current State Analysis

### Current Polling Logic (`src/http.ts:279-357`)

The `GET /api/poll` endpoint currently returns triggers in this priority order:

**For Both Workers and Leads:**
1. `task_offered` - When a task is offered to the agent
2. `task_assigned` - When a task is directly assigned (pending status)

**For Leads Only:**
3. `unread_mentions` - When there are unread @mentions
4. `pool_tasks_available` - When there are unassigned tasks in the pool

### Key Discoveries:
- Workers currently DON'T see unassigned tasks - only leads do (`http.ts:319-340`)
- There is NO trigger for recently finished tasks
- The `since` parameter is only used for channel messages (`db.ts:1456-1492`), not tasks
- Task statuses include: `unassigned`, `offered`, `pending`, `in_progress`, `completed`, `failed`

## Desired End State

After this implementation:

1. **Workers** will be triggered by:
   - `task_offered` - Tasks offered to them (existing)
   - `task_assigned` - Tasks assigned to them (existing)
   - `pool_tasks_available` - When there are unassigned tasks they can claim (NEW)

2. **Leads** will be triggered by:
   - `task_offered` - Tasks offered to them (existing, though rare)
   - `task_assigned` - Tasks assigned to them (existing, though rare)
   - `unread_mentions` - Unread @mentions (existing)
   - `tasks_finished` - When workers complete or fail tasks (NEW)

3. **Leads will NOT** be triggered by unassigned pool tasks (REMOVED)

### Verification:
- Workers should wake up and claim tasks when unassigned tasks exist
- Leads should wake up when worker tasks complete/fail
- Leads should NOT wake up when unassigned tasks are added to pool

## What We're NOT Doing

- Not changing the MCP-level `poll-task` tool (only HTTP runner-level polling)
- Not changing how tasks are created or assigned
- Not adding task completion notifications to workers (they don't need to know)
- Not persisting the "since" timestamp between restarts (it's per-poll session)

## Implementation Approach

The changes are focused on the `GET /api/poll` endpoint in `src/http.ts`. We need to:
1. Add a new database function to get recently finished tasks
2. Modify the poll trigger logic to swap unassigned tasks from lead to worker
3. Add a new trigger type `tasks_finished` for leads
4. Support an optional `since` query parameter for the finished tasks check

---

## Phase 1: Add Database Function for Recently Finished Tasks

### Overview
Add a function to query tasks that have finished (completed/failed) since a given timestamp, for non-lead agents (i.e., worker-completed tasks).

### Changes Required:

#### 1. Database Layer
**File**: `src/be/db.ts`
**Changes**: Add a new function `getRecentlyFinishedWorkerTasks`

After `getCompletedSlackTasks` function (around line 729), add:

```typescript
/**
 * Get tasks that were recently finished (completed/failed) by workers (non-lead agents).
 * Used by leads to know when workers complete tasks.
 */
export function getRecentlyFinishedWorkerTasks(since?: string): AgentTask[] {
  const query = since
    ? `SELECT t.* FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status IN ('completed', 'failed')
       AND t.finishedAt > ?
       AND (a.isLead = 0 OR a.isLead IS NULL)
       ORDER BY t.finishedAt DESC
       LIMIT 50`
    : `SELECT t.* FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status IN ('completed', 'failed')
       AND t.finishedAt IS NOT NULL
       AND (a.isLead = 0 OR a.isLead IS NULL)
       ORDER BY t.finishedAt DESC
       LIMIT 10`;

  if (since) {
    return getDb()
      .prepare<AgentTaskRow, [string]>(query)
      .all(since)
      .map(rowToAgentTask);
  }

  return getDb()
    .prepare<AgentTaskRow, []>(query)
    .all()
    .map(rowToAgentTask);
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript type checking passes: `bun run tsc --noEmit`
- [x] No linting errors: `bun run lint`

#### Manual Verification:
- [ ] Function returns expected results when queried directly via SQLite

**Implementation Note**: After completing this phase and all automated verification passes, proceed to Phase 2.

---

## Phase 2: Add Trigger Type and Update HTTP Polling

### Overview
Modify the poll endpoint to:
1. Move `pool_tasks_available` from leads to workers
2. Add `tasks_finished` trigger for leads
3. Support optional `since` query parameter

### Changes Required:

#### 1. Update Trigger Type
**File**: `src/commands/runner.ts`
**Changes**: Add the new trigger type to the interface

At line 124-130, update the `Trigger` interface:

```typescript
/** Trigger types returned by the poll API */
interface Trigger {
  type: "task_assigned" | "task_offered" | "unread_mentions" | "pool_tasks_available" | "tasks_finished";
  taskId?: string;
  task?: unknown;
  mentionsCount?: number;
  count?: number;
  tasks?: unknown[]; // For tasks_finished - list of finished tasks
}
```

#### 2. Update Prompt Building
**File**: `src/commands/runner.ts`
**Changes**: Handle the new `tasks_finished` trigger

At line 211-233, update `buildPromptForTrigger`:

```typescript
/** Build prompt based on trigger type */
function buildPromptForTrigger(trigger: Trigger, defaultPrompt: string): string {
  switch (trigger.type) {
    case "task_assigned":
      // Use the work-on-task command with task ID
      return `/work-on-task ${trigger.taskId}`;

    case "task_offered":
      // Use the review-offered-task command to accept/reject
      return `/review-offered-task ${trigger.taskId}`;

    case "unread_mentions":
      // Check messages
      return "/swarm-chat";

    case "pool_tasks_available":
      // Worker: claim a task from the pool
      return "/claim-task";

    case "tasks_finished":
      // Lead: review finished tasks
      return "/review-finished-tasks";

    default:
      return defaultPrompt;
  }
}
```

#### 3. Update HTTP Poll Endpoint
**File**: `src/http.ts`
**Changes**: Restructure the poll logic

First, add the import at the top of the file (around line 34):

```typescript
import {
  // ... existing imports ...
  getRecentlyFinishedWorkerTasks,
} from "./be/db";
```

Then update the poll endpoint (lines 279-357):

```typescript
// GET /api/poll - Poll for triggers (tasks, mentions, etc.)
if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "poll") {
  if (!myAgentId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
    return;
  }

  // Get optional 'since' parameter for finished tasks
  const since = queryParams.get("since") || undefined;

  // Use transaction for consistent reads across all trigger checks
  const result = getDb().transaction(() => {
    const agent = getAgentById(myAgentId);
    if (!agent) {
      return { error: "Agent not found", status: 404 };
    }

    // Check for offered tasks first (highest priority for both workers and leads)
    const offeredTasks = getOfferedTasksForAgent(myAgentId);
    const firstOfferedTask = offeredTasks[0];
    if (firstOfferedTask) {
      return {
        trigger: {
          type: "task_offered",
          taskId: firstOfferedTask.id,
          task: firstOfferedTask,
        },
      };
    }

    // Check for pending tasks (assigned directly to this agent)
    const pendingTask = getPendingTaskForAgent(myAgentId);
    if (pendingTask) {
      return {
        trigger: {
          type: "task_assigned",
          taskId: pendingTask.id,
          task: pendingTask,
        },
      };
    }

    if (agent.isLead) {
      // === LEAD-SPECIFIC TRIGGERS ===

      // Check for unread mentions
      const inbox = getInboxSummary(myAgentId);
      if (inbox.mentionsCount > 0) {
        return {
          trigger: {
            type: "unread_mentions",
            mentionsCount: inbox.mentionsCount,
          },
        };
      }

      // Check for recently finished worker tasks
      const finishedTasks = getRecentlyFinishedWorkerTasks(since);
      if (finishedTasks.length > 0) {
        return {
          trigger: {
            type: "tasks_finished",
            count: finishedTasks.length,
            tasks: finishedTasks,
          },
        };
      }
    } else {
      // === WORKER-SPECIFIC TRIGGERS ===

      // Check for unassigned tasks in pool (workers can claim)
      const unassignedCount = getUnassignedTasksCount();
      if (unassignedCount > 0) {
        return {
          trigger: {
            type: "pool_tasks_available",
            count: unassignedCount,
          },
        };
      }
    }

    // No trigger found
    return { trigger: null };
  })();

  // Handle error case
  if ("error" in result) {
    res.writeHead(result.status ?? 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: result.error }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
  return;
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript type checking passes: `bun run tsc --noEmit`
- [x] No linting errors: `bun run lint`

#### Manual Verification:
- [ ] Worker polling shows `pool_tasks_available` when unassigned tasks exist
- [ ] Lead polling does NOT show `pool_tasks_available`
- [ ] Lead polling shows `tasks_finished` when worker tasks complete

**Implementation Note**: After completing this phase and all automated verification passes, proceed to Phase 3.

---

## Phase 3: Update Runner to Track Last Poll Time

### Overview
Update the runner to pass a `since` timestamp when polling, so the lead only sees newly finished tasks.

### Changes Required:

#### 1. Update Runner Polling
**File**: `src/commands/runner.ts`
**Changes**: Track and pass the `since` parameter

Update the polling loop (around line 459-468) to track when tasks were last checked:

```typescript
// Before the while loop, add:
let lastFinishedTaskCheck: string | undefined;

// Inside the while loop, update the pollForTrigger call and result handling:
while (true) {
  console.log(`\n[${role}] Polling for triggers...`);

  const trigger = await pollForTrigger({
    apiUrl,
    apiKey,
    agentId,
    pollInterval: POLL_INTERVAL_MS,
    pollTimeout: POLL_TIMEOUT_MS,
    since: lastFinishedTaskCheck, // Pass the since parameter
  });

  // After getting a tasks_finished trigger, update the timestamp
  if (trigger?.type === "tasks_finished") {
    lastFinishedTaskCheck = new Date().toISOString();
  }

  // ... rest of the logic
}
```

Update the `PollOptions` interface (around line 132-139):

```typescript
/** Options for polling */
interface PollOptions {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  pollInterval: number;
  pollTimeout: number;
  since?: string; // Optional: for filtering finished tasks
}
```

Update the `pollForTrigger` function (around line 174-209) to pass the `since` parameter:

```typescript
/** Poll for triggers via HTTP API */
async function pollForTrigger(opts: PollOptions): Promise<Trigger | null> {
  const startTime = Date.now();
  const headers: Record<string, string> = {
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  while (Date.now() - startTime < opts.pollTimeout) {
    try {
      // Build URL with optional since parameter
      let url = `${opts.apiUrl}/api/poll`;
      if (opts.since) {
        url += `?since=${encodeURIComponent(opts.since)}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        console.warn(`[runner] Poll request failed: ${response.status}`);
        await Bun.sleep(opts.pollInterval);
        continue;
      }

      const data = (await response.json()) as { trigger: Trigger | null };
      if (data.trigger) {
        return data.trigger;
      }
    } catch (error) {
      console.warn(`[runner] Poll request error: ${error}`);
    }

    await Bun.sleep(opts.pollInterval);
  }

  return null; // Timeout reached, no trigger found
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript type checking passes: `bun run tsc --noEmit`
- [x] No linting errors: `bun run lint`

#### Manual Verification:
- [ ] Lead only sees `tasks_finished` once per completed task (not repeatedly)
- [ ] After lead processes finished tasks, subsequent polls don't return the same tasks

**Implementation Note**: After completing this phase, run full integration test.

---

## Phase 4: Update Prompt Building for New Triggers

### Overview
Update the prompt building to handle the new triggers appropriately:
- Workers should be prompted to claim an unassigned task (first come, first serve)
- Leads should receive a simple notification about finished tasks

### Design Decision: Race Condition Safety
The existing `claimTask` function in `db.ts:1041-1067` already handles race conditions safely:
- It uses a transaction with a status check
- Only tasks with `status = 'unassigned'` can be claimed
- If two workers try to claim simultaneously, only the first succeeds
- The second worker gets an error and can try another task

### Changes Required:

#### 1. Update Prompt Building
**File**: `src/commands/runner.ts`
**Changes**: Update `buildPromptForTrigger` for the new trigger behaviors

The `pool_tasks_available` trigger for workers should include task info so they can claim immediately:

```typescript
/** Build prompt based on trigger type */
function buildPromptForTrigger(trigger: Trigger, defaultPrompt: string): string {
  switch (trigger.type) {
    case "task_assigned":
      return `/work-on-task ${trigger.taskId}`;

    case "task_offered":
      return `/review-offered-task ${trigger.taskId}`;

    case "unread_mentions":
      return "/swarm-chat";

    case "pool_tasks_available":
      // Worker: claim a task from the pool
      // Include the count so worker knows there are tasks available
      return `There are ${trigger.count} unassigned task(s) available in the pool. Use get-tasks with unassigned: true to see them, then use task-action with action: "claim" to claim one. The claim is first-come-first-serve, so if your claim fails, try another task.`;

    case "tasks_finished":
      // Lead: simple notification about finished tasks
      if (trigger.tasks && Array.isArray(trigger.tasks) && trigger.tasks.length > 0) {
        const taskSummaries = trigger.tasks.map((t: any) => {
          const status = t.status === "completed" ? "completed" : "failed";
          const agentName = t.agentId ? `Agent ${t.agentId.slice(0, 8)}` : "Unknown agent";
          return `- ${agentName} ${status} task "${t.task?.slice(0, 50)}..." (ID: ${t.id})`;
        }).join("\n");
        return `Workers have finished ${trigger.count} task(s):\n${taskSummaries}\n\nReview these results and decide if any follow-up actions are needed.`;
      }
      return `Workers have finished ${trigger.count} task(s). Use get-tasks with status "completed" or "failed" to review them.`;

    default:
      return defaultPrompt;
  }
}
```

#### 2. Update Trigger Interface
**File**: `src/commands/runner.ts`
**Changes**: Ensure the `tasks` field is properly typed

```typescript
/** Trigger types returned by the poll API */
interface Trigger {
  type: "task_assigned" | "task_offered" | "unread_mentions" | "pool_tasks_available" | "tasks_finished";
  taskId?: string;
  task?: unknown;
  mentionsCount?: number;
  count?: number;
  tasks?: Array<{
    id: string;
    agentId?: string;
    task: string;
    status: string;
  }>;
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript type checking passes: `bun run tsc --noEmit`
- [x] No linting errors: `bun run lint`

#### Manual Verification:
- [ ] Worker receives clear prompt about available tasks
- [ ] Worker can successfully claim a task
- [ ] If two workers race, only one succeeds, the other gets an error
- [ ] Lead receives notification with task details when workers finish

---

## Testing Strategy

### Unit Tests:
- Test `getRecentlyFinishedWorkerTasks` with various `since` values
- Test that leads don't see unassigned tasks triggers
- Test that workers don't see finished tasks triggers

### Integration Tests:
- Create an unassigned task, verify worker gets `pool_tasks_available`
- Complete a task as worker, verify lead gets `tasks_finished`
- Verify lead does NOT get `pool_tasks_available`

### Manual Testing Steps:
1. Start a worker and lead
2. Create an unassigned task via API
3. Verify worker wakes up (not lead)
4. Worker claims and completes the task
5. Verify lead wakes up with `tasks_finished`
6. Verify lead can review the completed task

## Performance Considerations

- The `getRecentlyFinishedWorkerTasks` query is limited to 50 results when using `since`, 10 otherwise
- The `since` parameter prevents leads from repeatedly processing the same finished tasks
- No additional indexes needed - existing `idx_agent_tasks_status` covers the query

## Migration Notes

No database migration needed - we're only adding a new query function and modifying polling behavior.

## References

- Current poll endpoint: `src/http.ts:279-357`
- Runner polling: `src/commands/runner.ts:459-538`
- Database task queries: `src/be/db.ts:656-716`
- Existing worker/lead configs: `src/commands/worker.ts` and `src/commands/lead.ts`
