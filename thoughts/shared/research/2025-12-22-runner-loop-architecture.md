---
date: 2025-12-22T17:45:00-08:00
researcher: master lord
git_commit: d1c17d6b4588df88de9a8587b6e2cc245d9014ff
branch: main
repository: agent-swarm
topic: "Runner While Loop and Task Triggering Architecture"
tags: [research, codebase, runner, poll-task, slack, task-assignment, ai-loop]
status: complete
last_updated: 2025-12-22
last_updated_by: master lord
last_updated_note: "Added AI-based loop analysis, user feedback, and proposed architecture"
---

# Research: Runner While Loop and Task Triggering Architecture

**Date**: 2025-12-22T17:45:00-08:00
**Researcher**: master lord
**Git Commit**: d1c17d6b4588df88de9a8587b6e2cc245d9014ff
**Branch**: main
**Repository**: agent-swarm

## Research Question

Document the current architecture of the runner while loop, poll API, task assignment mechanisms, and how leads/workers are triggered. This research supports understanding how to change from a continuous-loop model to an on-demand spawn model.

## Summary

The current architecture runs agents in an **infinite while loop** that unconditionally spawns Claude on each iteration. Task waiting happens **inside Claude** via the `poll-task` MCP tool, not before spawning. Both lead and worker agents use the same runner loop with different prompts. Slack integration creates tasks on mentions but does **not** create tasks for regular thread follow-ups without an explicit @mention.

## Detailed Findings

### 1. Runner While Loop Implementation

**File**: `src/commands/runner.ts`

The runner is a simple infinite loop at **line 208**:

```typescript
while (true) {
  iteration++;
  // ... logging and metadata
  const exitCode = await runClaudeIteration({...});
  // ... error handling
  console.log(`[${role}] Iteration ${iteration} complete. Starting next iteration...`);
}
```

**Key characteristics:**
- **No pre-spawn task checking** - Claude is spawned immediately on each iteration
- **No external trigger waiting** - The loop runs unconditionally
- **Claude spawned via `Bun.spawn()`** at line 85 with command-line arguments
- **Error handling** - On exit code != 0, stops unless YOLO mode is enabled (line 247-253)

**`runClaudeIteration()` function (lines 57-136):**
```typescript
const proc = Bun.spawn(CMD, {
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
```

The command array includes:
- `claude --verbose --output-format stream-json`
- `--dangerously-skip-permissions` flags
- `-p <prompt>` with the role-specific prompt
- `--append-system-prompt` with base prompt + optional additional prompt

### 2. Lead vs Worker Configuration

**Lead Agent** (`src/commands/lead.ts`):
```typescript
const leadConfig: RunnerConfig = {
  role: "lead",
  defaultPrompt: "/start-leader",
  metadataType: "lead_metadata",
  capabilities: getEnabledCapabilities(),
};
```

**Worker Agent** (`src/commands/worker.ts`):
```typescript
const workerConfig: RunnerConfig = {
  role: "worker",
  defaultPrompt: "/start-worker",
  metadataType: "worker_metadata",
  capabilities: getEnabledCapabilities(),
};
```

Both use the same `runAgent()` function - the only difference is:
1. The `role` string for logging
2. The `defaultPrompt` (which triggers different plugin commands)
3. The `metadataType` for log files

### 3. Current AI-Based Loop (Inside Claude)

The current architecture relies on **AI-driven polling** defined in plugin commands. This is problematic because it consumes tokens and is unreliable (Claude decides when/how to poll).

**Worker Loop** (`plugin/commands/start-worker.md`):
```
1. Check for existing tasks with `get-tasks mineOnly=true`
   1.1. If in-progress task exists, resume it
2. If no tasks, call `poll-task` (waits up to 1 minute inside Claude)
   2.1. If task assigned → call `/work-on-task <taskId>`
   2.2. If no task → "start polling immediately FOREVER"
3. Only stop if interrupted by user
```

**Leader Loop** (`plugin/commands/start-leader.md`):
```
1. Check `get-swarm` and `get-tasks` to understand current state
2. Assign work to idle workers via `send-task`
3. Periodically check `get-task-details` on in-progress tasks
4. Use `read-messages` to catch @mentions
5. Use `poll-task` for tasks needing your attention
6. Provide updates to user on overall progress
```

**Work on Task** (`plugin/commands/work-on-task.md`):
```
1. Call `get-task-details` to get task info
2. Add todo item for tracking
3. Call `store-progress` to mark as in-progress
4. Work on task, calling `store-progress` periodically
5. On completion, mark as complete/failed and reply "DONE"
```

**Problems with AI-based loop:**
- **Token consumption**: Every poll iteration consumes Claude tokens
- **Unreliability**: Claude decides when/how to poll, may miss tasks
- **No external control**: Can't trigger Claude spawn from outside events
- **Session persistence**: Claude session stays alive, consuming resources

### 4. Poll-Task API Implementation

**File**: `src/tools/poll-task.ts`

The poll-task is an **MCP tool called from within Claude**, not an external pre-spawn mechanism.

**Constants (lines 16-17):**
```typescript
const DEFAULT_POLL_INTERVAL_MS = 2000;      // 2 seconds
const MAX_POLL_DURATION_MS = 1 * 60 * 1000; // 1 minute
```

**Behavior flow:**

1. **Check for offered tasks first** (lines 83-104):
   - If tasks are offered to the agent, returns immediately
   - Agent must use `task-action` with `accept` or `reject`

2. **Poll for pending tasks** (lines 107-162):
   - While loop with 2-second sleep intervals
   - Maximum duration of 1 minute before timing out
   - Uses database transaction to avoid race conditions (line 109)

3. **Auto-start task on find** (lines 120-128):
   - When a pending task is found, `startTask()` is called
   - Task status changes from `pending` to `in_progress`
   - Agent status updated to `busy`

**Return structure:**
```typescript
{
  success: boolean,
  message: string,
  task?: AgentTask,           // The started task (if found)
  offeredTasks: AgentTask[],  // Tasks awaiting accept/reject
  availableCount: number,     // Unassigned tasks in pool
  waitedForSeconds: number    // How long polling took
}
```

### 5. Slack Integration - Task Creation

**File**: `src/slack/handlers.ts`

**Message handler registration** (lines 140-273):
```typescript
app.event("message", async ({ event, client, say }) => {
  // 1. Ignore bot messages and message_changed
  // 2. Deduplicate events
  // 3. Check if bot was mentioned
  // 4. Route message to agents
  // 5. Rate limit check
  // 6. Extract task description
  // 7. Create tasks for matched agents
});
```

**Task creation** (lines 231-237):
```typescript
const task = createTask(agent.id, fullTaskDescription, {
  source: "slack",
  slackChannelId: msg.channel,
  slackThreadTs: threadTs,
  slackUserId: msg.user,
});
```

Tasks are created with status `pending` (directly assigned to agent).

### 6. Slack Message Routing

**File**: `src/slack/router.ts`

**`routeMessage()` function** (lines 77-155) - Routing rules in order:

| Priority | Pattern | Target | Code Location |
|----------|---------|--------|---------------|
| 1 | `swarm#<uuid>` | Exact agent by ID | lines 86-95 |
| 2 | `swarm#all` | All non-lead agents | lines 97-105 |
| 3 | Partial name match (3+ chars) | Agent by name | lines 107-120 |
| 4 | Multiple partial matches | Lead agent (to decide) | lines 122-135 |
| 5 | Thread follow-up (no match) | Agent working on thread | lines 138-144 |
| 6 | Bot @mention only | Lead agent | lines 146-152 |

**Thread follow-up handling** (lines 138-144):
```typescript
if (matches.length === 0 && threadContext) {
  const workingAgent = getAgentWorkingOnThread(threadContext.channelId, threadContext.threadTs);
  if (workingAgent && workingAgent.status !== "offline") {
    matches.push({ agent: workingAgent, matchedText: "thread follow-up" });
  }
}
```

**Current limitation**: Thread follow-ups only trigger when:
1. The message handler is invoked (requires bot mention OR agent name match)
2. No explicit agent match found, AND
3. An agent is already working on that thread

**Regular thread replies WITHOUT @mention do NOT create tasks.**

### 7. Database: Thread Agent Lookup

**File**: `src/be/db.ts`

**`getAgentWorkingOnThread()` function** (lines 732-747):
```sql
SELECT * FROM agent_tasks
WHERE source = 'slack'
  AND slackChannelId = ?
  AND slackThreadTs = ?
  AND status IN ('in_progress', 'pending')
ORDER BY createdAt DESC
LIMIT 1
```

Returns the agent that has an active task in the specified Slack thread.

### 8. Hook System

**File**: `src/hooks/hook.ts`

The hook system provides status information at various Claude lifecycle events but does **not** control spawning:

| Event | Current Behavior |
|-------|------------------|
| `SessionStart` | Shows agent registration status |
| `PreCompact` | (No specific action) |
| `PreToolUse` | (No specific action) |
| `PostToolUse` | Reminders about `store-progress` |
| `UserPromptSubmit` | (No specific action) |
| `Stop` | Saves PM2 state, marks agent offline |

The hook fetches agent info via HTTP `/me?include=inbox` endpoint (line 124) and displays system tray with:
- Unread message count
- Offered tasks count
- Pool tasks count
- In-progress tasks count
- Recent @mentions

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Current Architecture                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CLI invocation (worker/lead command)                           │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────┐           │
│  │  runAgent() - src/commands/runner.ts             │           │
│  │  ┌────────────────────────────────────────────┐  │           │
│  │  │  while (true) {                            │  │           │
│  │  │    // No external trigger waiting          │  │           │
│  │  │    // Spawns Claude immediately            │  │           │
│  │  │    exitCode = await runClaudeIteration()   │  │           │
│  │  │  }                                         │  │           │
│  │  └────────────────────────────────────────────┘  │           │
│  └──────────────────────────────────────────────────┘           │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────┐           │
│  │  Claude Process                                   │           │
│  │  - Receives /start-leader or /start-worker prompt│           │
│  │  - Calls MCP tools internally                     │           │
│  │  - Uses poll-task to wait for assignments         │           │
│  │  - Task waiting happens INSIDE Claude             │           │
│  └──────────────────────────────────────────────────┘           │
│                                                                  │
│  ┌──────────────────────────────────────────────────┐           │
│  │  Slack Integration (separate process)             │           │
│  │  - Creates tasks on mentions                      │           │
│  │  - Does NOT notify running agents directly        │           │
│  │  - Agents must poll to discover new tasks         │           │
│  └──────────────────────────────────────────────────┘           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Code References

- `src/commands/runner.ts:208` - Main while loop
- `src/commands/runner.ts:57-136` - `runClaudeIteration()` function
- `src/commands/runner.ts:85` - `Bun.spawn()` call
- `src/commands/lead.ts:6-11` - Lead configuration
- `src/commands/worker.ts:6-11` - Worker configuration
- `src/tools/poll-task.ts:16-17` - Polling constants
- `src/tools/poll-task.ts:83-104` - Offered tasks check
- `src/tools/poll-task.ts:107-162` - Polling loop
- `src/slack/handlers.ts:140-273` - Message handler
- `src/slack/handlers.ts:231-237` - Task creation
- `src/slack/router.ts:77-155` - `routeMessage()` function
- `src/slack/router.ts:138-144` - Thread follow-up routing
- `src/be/db.ts:732-747` - `getAgentWorkingOnThread()`
- `src/hooks/hook.ts:56-290` - Hook handler

## Current Spawn Triggers Summary

### Lead Agent (Current)
| Trigger | Creates Task? | Spawns Agent? |
|---------|---------------|---------------|
| CLI invocation | No | Yes (runs forever) |
| @bot mention in Slack | Yes | No (already running) |
| Agent finished a task | N/A | No (already running) |

### Worker Agent (Current)
| Trigger | Creates Task? | Spawns Agent? |
|---------|---------------|---------------|
| CLI invocation | No | Yes (runs forever) |
| `swarm#<uuid>` in Slack | Yes | No (already running) |
| `swarm#all` in Slack | Yes | No (already running) |
| Agent name match in Slack | Yes | No (already running) |
| Thread follow-up | Yes | No (already running) |
| `send-task` from lead | Yes | No (already running) |
| Offered task (poll-task returns) | No (exists) | N/A |

### Slack Thread Behavior
| Scenario | Task Created? |
|----------|---------------|
| @bot mention in new message | Yes (to lead) |
| @bot mention in thread | Yes (to lead or working agent) |
| Agent name in thread | Yes (to matched agent) |
| `swarm#<uuid>` in thread | Yes (to specified agent) |
| Reply in thread WITHOUT @mention | **No** |
| Reply in thread to agent working on it | **No** (unless @mention or name match) |

## Proposed Architecture: Runner-Level Polling

### Design Decisions

Based on discussion, the following decisions have been made:

1. **Thread reply detection**: Will need to subscribe to all thread messages in Slack, not just mentions. This is a Slack configuration change.

2. **Agent process lifecycle**: Polling should happen **at the runner level** (TypeScript), not inside Claude:
   - Wait for something with a timeout
   - If nothing, wait a bit and repeat
   - If got something, spawn Claude to process it and repeat

3. **MCP session persistence**: Each spawn will be a new session. Remove the `SESSION_ID` parameter for now.

4. **Offered task acceptance**: Spawn Claude with a prompt like:
   > "Hey there's task <id>, check it out and accept it if you think it's good for your skills"

5. **Configuration**: The approach should be **opt-in** via `--ai-loop` flag:
   - Default (new): Runner-level polling, spawn on-demand
   - `--ai-loop`: Current behavior (AI-based polling inside Claude)

### Proposed Runner Flow (Pseudocode)

```typescript
// src/commands/runner.ts - proposed changes

export async function runAgent(config: RunnerConfig, opts: RunnerOptions) {
  const { role } = config;
  const swarmUrl = process.env.SWARM_URL || 'http://localhost:3013';
  const apiKey = process.env.API_KEY || '';
  const agentId = process.env.AGENT_ID || crypto.randomUUID();

  // Step 1: Register agent via API (before polling)
  const agent = await registerAgent(swarmUrl, apiKey, {
    id: agentId,
    name: opts.name || `${role}-${agentId.slice(0, 8)}`,
    isLead: role === 'lead',
    capabilities: config.capabilities,
  });

  console.log(`[${role}] Registered as "${agent.name}" (ID: ${agent.id})`);

  while (true) {
    if (opts.aiLoop) {
      // Current behavior: spawn Claude immediately with /start-* prompt
      await runClaudeIteration({ prompt: config.defaultPrompt });
    } else {
      // New behavior: poll at runner level via API
      const trigger = await pollForTrigger(swarmUrl, apiKey, agentId, {
        timeout: POLL_TIMEOUT_MS,      // e.g., 60000 (1 min)
        checkInterval: POLL_INTERVAL_MS, // e.g., 2000 (2 sec)
      });

      if (trigger) {
        // Spawn Claude with specific prompt based on trigger type
        const prompt = buildPromptForTrigger(trigger);
        await runClaudeIteration({ prompt });
      }
      // If no trigger (timeout), loop continues (wait and repeat)
    }
  }
}

// API call to register agent
async function registerAgent(swarmUrl: string, apiKey: string, opts: RegisterOpts): Promise<Agent> {
  const response = await fetch(`${swarmUrl}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-Agent-ID': opts.id,
    },
    body: JSON.stringify(opts),
  });

  if (!response.ok) {
    // Handle already-registered case (409 Conflict) - fetch existing
    if (response.status === 409) {
      const existing = await fetch(`${swarmUrl}/me`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'X-Agent-ID': opts.id },
      });
      return existing.json();
    }
    throw new Error(`Failed to register: ${response.statusText}`);
  }

  return response.json();
}

// API call to poll for triggers
async function pollForTrigger(
  swarmUrl: string,
  apiKey: string,
  opts: PollOpts
): Promise<Trigger | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < opts.timeout) {
    const response = await fetch(`${swarmUrl}/api/poll?agentId=${opts.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'X-Agent-ID': opts.id },
    });

    const data = await response.json();

    if (data.trigger) {
      return data.trigger; // { type: 'task_assigned', taskId: '...' }
    }

    await Bun.sleep(opts.checkInterval);
  }

  return null; // Timeout, no trigger
}
```

### Trigger Types and Prompts

| Trigger Type | Prompt | Command |
|--------------|--------|---------|
| Task assigned (pending) | "Work on task `<id>`" | `/work-on-task <id>` |
| Task offered | "Task `<id>` offered, check if it fits your skills" | (new command?) |
| Unread @mention | "You have unread mentions, check messages" | `/swarm-chat` |
| Agent finished task (lead) | "Worker completed task `<id>`, review results" | (custom) |

### Lead Agent Triggers (Proposed)

| Trigger | Creates Task? | Spawns Agent? |
|---------|---------------|---------------|
| @bot mention in Slack | Yes | **Yes** |
| Follow-up in thread (any message) | Yes | **Yes** |
| Direct task assignment | Yes | **Yes** |
| Any agent finished a task | No | **Yes** (to review) |
| Unread @mention in channels | No | **Yes** |

### Worker Agent Triggers (Proposed)

| Trigger | Creates Task? | Spawns Agent? |
|---------|---------------|---------------|
| Task assigned to them | Yes (already exists) | **Yes** |
| Task offered to them | Yes (already exists) | **Yes** (to accept/reject) |
| Direct mention in swarm chat | No | **Yes** |

### Critical: API-Based Architecture

The runner **cannot access the database directly** - the DB runs in the API service (could be different infrastructure). The runner must use HTTP API calls.

**Current API Endpoints** (`src/http.ts`):
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/me` | GET | Get agent info (requires `X-Agent-ID` header) |
| `/ping` | POST | Update agent status to idle/busy |
| `/close` | POST | Mark agent offline |
| `/api/agents` | GET | List all agents |
| `/api/tasks` | GET | List tasks with filters |
| `/api/tasks/:id` | GET | Get task details |

**Missing API Endpoints (Need to Add)**:
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/agents` | POST | Register an agent (equivalent to `join-swarm` MCP tool) |
| `/api/poll` | GET | Poll for triggers (tasks, mentions, etc.) |

**Agent Registration Flow (New)**:
```typescript
// Runner must register BEFORE polling
const response = await fetch(`${swarmUrl}/api/agents`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${apiKey}`, 'X-Agent-ID': agentId },
  body: JSON.stringify({
    name: agentName,
    isLead: role === 'lead',
    capabilities: config.capabilities,
  }),
});
```

**Polling Flow (New)**:
```typescript
// Poll for triggers via API
const response = await fetch(`${swarmUrl}/api/poll`, {
  method: 'GET',
  headers: { 'Authorization': `Bearer ${apiKey}`, 'X-Agent-ID': agentId },
});
const trigger = await response.json();
// trigger: { type: 'task_assigned', taskId: '...' } | null
```

**Types Reuse**: Types from `src/types.ts` (`AgentSchema`, `AgentTaskSchema`, etc.) can be reused in the runner since they're in the same codebase.

### Files to Modify

1. **`src/http.ts`** (NEW)
   - Add `POST /api/agents` - Agent registration endpoint
   - Add `GET /api/poll` - Trigger polling endpoint

2. **`src/commands/runner.ts`**
   - Add `--ai-loop` flag handling
   - Add `pollForTrigger()` function (calls `GET /api/poll`)
   - Add `registerAgent()` function (calls `POST /api/agents`)
   - Add `buildPromptForTrigger()` function
   - Remove `SESSION_ID` usage

3. **`src/commands/lead.ts` / `src/commands/worker.ts`**
   - Pass `aiLoop` config option

4. **`src/cli.tsx`**
   - Add `--ai-loop` CLI flag

5. **`plugin/commands/work-on-task.md`**
   - Consider reuse for lead (or create `/lead-work-on-task`)

6. **`src/slack/handlers.ts`** (future)
   - Subscribe to all thread messages, not just mentions

### Open Questions (Remaining)

1. **Lead work-on-task**: Should we reuse `/work-on-task` for lead, or create a separate `/lead-work-on-task` command? Reuse preferred if possible.

2. **Slack thread subscription**: Need to investigate Slack API for subscribing to all messages in threads where bot is active (not just mentions).
