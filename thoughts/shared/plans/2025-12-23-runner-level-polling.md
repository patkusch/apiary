# Runner-Level Polling Implementation Plan

## Overview

Move task polling from inside Claude (MCP tool consuming tokens) to the runner level (TypeScript), so agents are only spawned when there's actual work to do. This reduces token consumption, improves reliability, and enables external event-driven spawning.

## Current State Analysis

### How It Works Now

1. **Runner** (`src/commands/runner.ts:208`): Infinite `while(true)` loop that spawns Claude immediately on each iteration
2. **Claude**: Receives `/start-worker` or `/start-leader` prompt, then uses `poll-task` MCP tool to wait for tasks
3. **poll-task** (`src/tools/poll-task.ts`): Polls database every 2 seconds for up to 1 minute, consuming Claude tokens the entire time
4. **Registration**: Happens inside Claude via `join-swarm` MCP tool

### Problems

- **Token consumption**: Every poll iteration consumes Claude tokens
- **Unreliability**: Claude decides when/how to poll, may miss tasks or poll inefficiently
- **No external control**: Can't trigger Claude spawn from outside events (Slack, webhooks, etc.)
- **Session persistence**: Claude session stays alive during polling, consuming resources

### Key Discoveries

- Runner spawns Claude via `Bun.spawn()` at `src/commands/runner.ts:85`
- Runner options defined at `src/commands/runner.ts:40-47`
- CLI parsing at `src/cli.tsx:38-101` handles flags like `--yolo`, `--system-prompt`
- HTTP API at `src/http.ts` already has `/me`, `/ping`, `/close` endpoints
- Database functions at `src/be/db.ts` have all needed queries (`getOfferedTasksForAgent`, `getPendingTaskForAgent`, `getUnassignedTasksCount`)

## Desired End State

After this implementation:

1. **Runner polls via HTTP API** before spawning Claude
2. **Claude is only spawned** when there's a trigger (task, mention, etc.)
3. **`--ai-loop` flag** enables the old behavior for backwards compatibility
4. **New API endpoints** support agent registration and trigger polling from the runner
5. **Agents register at runner level** before polling begins

### Verification

- `bun run worker` without `--ai-loop` should poll via HTTP and only spawn Claude when work arrives
- `bun run worker --ai-loop` should behave like the current implementation
- `GET /api/poll` should return triggers when tasks/mentions exist
- `POST /api/agents` should register a new agent

## What We're NOT Doing

- **Slack thread subscription changes**: This requires Slack API changes (out of scope)
- **Session persistence across spawns**: Each spawn will be a new Claude session (as designed)
- **Removing poll-task MCP tool**: It remains available for AI-loop mode and manual use
- **Lead-specific trigger types**: Same polling mechanism for both roles initially

## Implementation Approach

We'll implement this in four phases:

1. **Phase 1**: Add HTTP API endpoints for agent registration and trigger polling
2. **Phase 2**: Add `/review-offered-task` plugin command
3. **Phase 3**: Update runner to poll via API and spawn Claude on-demand
4. **Phase 4**: Update CLI and add `--ai-loop` flag for backwards compatibility

## Phase 1: HTTP API Endpoints

### Overview

Add two new HTTP API endpoints to enable runner-level polling.

**Important**: Both endpoints use database transactions (`getDb().transaction()`) to ensure:
- **Atomicity**: Check-and-create/update operations complete as a single unit
- **Consistency**: Multiple reads (e.g., checking offered tasks, then pending tasks) see a consistent database state
- **Isolation**: Concurrent requests don't interfere with each other (e.g., two agents trying to claim the same task)

### Changes Required

#### 1. Add Agent Registration Endpoint

**File**: `src/http.ts`
**Location**: After line 210 (after `/close` endpoint)

Add `POST /api/agents` endpoint for runner-level agent registration:

```typescript
// POST /api/agents - Register a new agent (or return existing if already registered)
if (
  req.method === "POST" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "agents" &&
  !pathSegments[2]
) {
  // Parse request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  // Validate required fields
  if (!body.name || typeof body.name !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid 'name' field" }));
    return;
  }

  // Use X-Agent-ID header if provided, otherwise generate new UUID
  const agentId = myAgentId || crypto.randomUUID();

  // Use transaction to ensure atomicity of check-and-create/update
  const result = getDb().transaction(() => {
    // Check if agent already exists
    const existingAgent = getAgentById(agentId);
    if (existingAgent) {
      // Update status to idle if offline
      if (existingAgent.status === "offline") {
        updateAgentStatus(existingAgent.id, "idle");
      }
      return { agent: getAgentById(agentId), created: false };
    }

    // Create new agent
    const agent = createAgent({
      id: agentId,
      name: body.name,
      isLead: body.isLead ?? false,
      status: "idle",
      description: body.description,
      role: body.role,
      capabilities: body.capabilities,
    });

    return { agent, created: true };
  })();

  res.writeHead(result.created ? 201 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.agent));
  return;
}
```

**Required import**: Add `createAgent` to imports from `./be/db`

#### 2. Add Trigger Polling Endpoint

**File**: `src/http.ts`
**Location**: After the agent registration endpoint

Add `GET /api/poll` endpoint for runner-level trigger polling:

```typescript
// GET /api/poll - Poll for triggers (tasks, mentions, etc.)
if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "poll") {
  if (!myAgentId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
    return;
  }

  // Use transaction for consistent reads across all trigger checks
  const result = getDb().transaction(() => {
    const agent = getAgentById(myAgentId);
    if (!agent) {
      return { error: "Agent not found", status: 404 };
    }

    // Check for offered tasks first (highest priority)
    const offeredTasks = getOfferedTasksForAgent(myAgentId);
    if (offeredTasks.length > 0) {
      return {
        trigger: {
          type: "task_offered",
          taskId: offeredTasks[0].id,
          task: offeredTasks[0],
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

    // For lead agents, check for unread mentions
    if (agent.isLead) {
      const inbox = getInboxSummary(myAgentId);
      if (inbox.mentionsCount > 0) {
        return {
          trigger: {
            type: "unread_mentions",
            mentionsCount: inbox.mentionsCount,
          },
        };
      }

      // Check for tasks needing assignment (unassigned tasks in pool)
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
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: result.error }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
  return;
}
```

**Required imports**: Add `getOfferedTasksForAgent`, `getPendingTaskForAgent`, `getUnassignedTasksCount` to imports from `./be/db`

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles without errors: `bun run tsc:check`
- [x] API returns 400 when X-Agent-ID missing for `/api/poll`
- [x] API returns 404 when agent doesn't exist
- [x] API returns trigger when offered task exists
- [x] API returns trigger when pending task exists
- [x] API returns `{ trigger: null }` when no work available

#### Manual Verification:
- [ ] Test with curl: `curl -X POST http://localhost:3013/api/agents -H "Content-Type: application/json" -H "X-Agent-ID: test-123" -d '{"name": "test-agent"}'`
- [ ] Test poll: `curl http://localhost:3013/api/poll -H "X-Agent-ID: test-123"`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Review Offered Task Command

### Overview

Add a new plugin command `/review-offered-task` that guides agents through the process of reviewing and accepting/rejecting offered tasks.

### Changes Required

#### 1. Create Plugin Command

**File**: `plugin/commands/review-offered-task.md` (NEW)

```markdown
---
description: Review a task that has been offered to you and decide whether to accept or reject it
argument-hint: [taskId]
---

# Review Offered Task

You have been offered a task. Your job is to review it and decide whether to accept or reject it based on your capabilities and current workload.

## Workflow

1. **Get task details**: Call the `get-task-details` tool with the provided `taskId` to understand what the task involves.

2. **Evaluate the task**: Consider:
   - Does this task match your capabilities?
   - Do you have the necessary context or access to complete it?
   - Is the task description clear enough to proceed?

3. **Make a decision**:
   - **Accept**: If you can complete this task, call `task-action` with `action: "accept"` and `taskId: "<taskId>"`. Then immediately use `/work-on-task <taskId>` to start working on it.
   - **Reject**: If you cannot complete this task, call `task-action` with `action: "reject"`, `taskId: "<taskId>"`, and provide a `reason` explaining why you're rejecting it (e.g., "Task requires Python expertise which I don't have", "Task description is too vague").

## Example Accept Flow

\`\`\`
1. get-task-details taskId="abc-123"
2. [Review the task details]
3. task-action action="accept" taskId="abc-123"
4. /work-on-task abc-123
\`\`\`

## Example Reject Flow

\`\`\`
1. get-task-details taskId="abc-123"
2. [Review the task details]
3. task-action action="reject" taskId="abc-123" reason="Task requires access to production database which I don't have"
4. Reply "DONE" to end the session
\`\`\`

## Important Notes

- Always provide a clear reason when rejecting a task - this helps the lead agent reassign it appropriately
- If you accept, you must immediately start working on the task using `/work-on-task`
- If you reject, the task returns to the unassigned pool for reassignment
```

### Success Criteria

#### Automated Verification:
- [x] File exists at `plugin/commands/review-offered-task.md`
- [x] File has valid YAML frontmatter with `description` and `argument-hint`

#### Manual Verification:
- [ ] Command appears in Claude's available commands when running with the plugin
- [ ] Running `/review-offered-task <id>` provides clear guidance

**Implementation Note**: After completing this phase, pause here for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Runner-Level Polling

### Overview

Update the runner to poll via HTTP API before spawning Claude, and only spawn when there's a trigger.

### Changes Required

#### 1. Add Trigger Types

**File**: `src/commands/runner.ts`
**Location**: After line 55 (after `RunClaudeIterationOptions` interface)

```typescript
/** Trigger types returned by the poll API */
interface Trigger {
  type: "task_assigned" | "task_offered" | "unread_mentions" | "pool_tasks_available";
  taskId?: string;
  task?: unknown;
  mentionsCount?: number;
  count?: number;
}

/** Options for polling */
interface PollOptions {
  swarmUrl: string;
  apiKey: string;
  agentId: string;
  pollInterval: number;
  pollTimeout: number;
}
```

#### 2. Add Registration Function

**File**: `src/commands/runner.ts`
**Location**: After the new interfaces

```typescript
/** Register agent via HTTP API */
async function registerAgent(opts: {
  swarmUrl: string;
  apiKey: string;
  agentId: string;
  name: string;
  isLead: boolean;
  capabilities?: string[];
}): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const response = await fetch(`${opts.swarmUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: opts.name,
      isLead: opts.isLead,
      capabilities: opts.capabilities,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register agent: ${response.status} ${error}`);
  }
}
```

#### 3. Add Poll Function

**File**: `src/commands/runner.ts`
**Location**: After `registerAgent` function

```typescript
/** Poll for triggers via HTTP API */
async function pollForTrigger(opts: PollOptions): Promise<Trigger | null> {
  const startTime = Date.now();
  const headers: Record<string, string> = {
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  while (Date.now() - startTime < opts.pollTimeout) {
    try {
      const response = await fetch(`${opts.swarmUrl}/api/poll`, {
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

#### 4. Add Prompt Builder Function

**File**: `src/commands/runner.ts`
**Location**: After `pollForTrigger` function

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
      // Let lead review and assign tasks
      return defaultPrompt;

    default:
      return defaultPrompt;
  }
}
```

#### 5. Update RunnerOptions Interface

**File**: `src/commands/runner.ts`
**Location**: Line 40-47 (update existing interface)

```typescript
export interface RunnerOptions {
  prompt?: string;
  yolo?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  logsDir?: string;
  additionalArgs?: string[];
  aiLoop?: boolean; // NEW: Use AI-based loop (old behavior)
}
```

#### 6. Update runAgent Function

**File**: `src/commands/runner.ts`
**Location**: Update the `runAgent` function (lines 138-258)

Replace the while loop section (lines 206-257) with:

```typescript
const isAiLoop = opts.aiLoop || process.env.AI_LOOP === "true";
const apiKey = process.env.API_KEY || "";

// Constants for polling
const POLL_INTERVAL_MS = 2000;  // 2 seconds between polls
const POLL_TIMEOUT_MS = 60000; // 1 minute timeout before retrying

let iteration = 0;

if (!isAiLoop) {
  // NEW: Runner-level polling mode
  console.log(`[${role}] Mode: runner-level polling (use --ai-loop for AI-based polling)`);

  // Register agent before starting
  const agentName = process.env.AGENT_NAME || `${role}-${agentId.slice(0, 8)}`;
  try {
    await registerAgent({
      swarmUrl,
      apiKey,
      agentId,
      name: agentName,
      isLead: role === "lead",
      capabilities: config.capabilities,
    });
    console.log(`[${role}] Registered as "${agentName}" (ID: ${agentId})`);
  } catch (error) {
    console.error(`[${role}] Failed to register: ${error}`);
    process.exit(1);
  }

  while (true) {
    console.log(`\n[${role}] Polling for triggers...`);

    const trigger = await pollForTrigger({
      swarmUrl,
      apiKey,
      agentId,
      pollInterval: POLL_INTERVAL_MS,
      pollTimeout: POLL_TIMEOUT_MS,
    });

    if (!trigger) {
      console.log(`[${role}] No trigger found, polling again...`);
      continue;
    }

    console.log(`[${role}] Trigger received: ${trigger.type}`);

    // Build prompt based on trigger
    const triggerPrompt = buildPromptForTrigger(trigger, prompt);

    iteration++;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = `${logDir}/${timestamp}.jsonl`;

    console.log(`\n[${role}] === Iteration ${iteration} ===`);
    console.log(`[${role}] Logging to: ${logFile}`);
    console.log(`[${role}] Prompt: ${triggerPrompt}`);

    const metadata = {
      type: metadataType,
      sessionId,
      iteration,
      timestamp: new Date().toISOString(),
      prompt: triggerPrompt,
      trigger: trigger.type,
      yolo: isYolo,
    };
    await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

    const exitCode = await runClaudeIteration({
      prompt: triggerPrompt,
      logFile,
      systemPrompt: resolvedSystemPrompt,
      additionalArgs: opts.additionalArgs,
      role,
    });

    if (exitCode !== 0) {
      const errorLog = {
        timestamp: new Date().toISOString(),
        iteration,
        exitCode,
        trigger: trigger.type,
        error: true,
      };

      const errorsFile = `${logDir}/errors.jsonl`;
      const errorsFileRef = Bun.file(errorsFile);
      const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
      await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

      if (!isYolo) {
        console.error(`[${role}] Claude exited with code ${exitCode}. Stopping.`);
        console.error(`[${role}] Error logged to: ${errorsFile}`);
        process.exit(exitCode);
      }

      console.warn(`[${role}] Claude exited with code ${exitCode}. YOLO mode - continuing...`);
    }

    console.log(`[${role}] Iteration ${iteration} complete. Polling for next trigger...`);
  }
} else {
  // Original AI-loop mode (existing behavior)
  console.log(`[${role}] Mode: AI-based polling (legacy)`);

  while (true) {
    iteration++;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = `${logDir}/${timestamp}.jsonl`;

    console.log(`\n[${role}] === Iteration ${iteration} ===`);
    console.log(`[${role}] Logging to: ${logFile}`);

    const metadata = {
      type: metadataType,
      sessionId,
      iteration,
      timestamp: new Date().toISOString(),
      prompt,
      yolo: isYolo,
    };
    await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

    const exitCode = await runClaudeIteration({
      prompt,
      logFile,
      systemPrompt: resolvedSystemPrompt,
      additionalArgs: opts.additionalArgs,
      role,
    });

    if (exitCode !== 0) {
      const errorLog = {
        timestamp: new Date().toISOString(),
        iteration,
        exitCode,
        error: true,
      };

      const errorsFile = `${logDir}/errors.jsonl`;
      const errorsFileRef = Bun.file(errorsFile);
      const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
      await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

      if (!isYolo) {
        console.error(`[${role}] Claude exited with code ${exitCode}. Stopping.`);
        console.error(`[${role}] Error logged to: ${errorsFile}`);
        process.exit(exitCode);
      }

      console.warn(`[${role}] Claude exited with code ${exitCode}. YOLO mode - continuing...`);
    }

    console.log(`[${role}] Iteration ${iteration} complete. Starting next iteration...`);
  }
}
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles without errors: `bun run tsc:check`
- [x] Runner starts without `--ai-loop` and logs "runner-level polling"
- [x] Runner with `--ai-loop` logs "AI-based polling (legacy)"

#### Manual Verification:
- [ ] Start MCP server: `bun run mcp`
- [ ] In another terminal, start worker: `AGENT_ID=test-worker SWARM_URL=http://localhost:3013 bun run worker`
- [ ] Verify worker polls and waits (no Claude spawned)
- [ ] Create a task via API and verify Claude is spawned
- [ ] Test `--ai-loop` flag works as before

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 4.

---

## Phase 4: CLI Flag and Final Integration

### Overview

Add the `--ai-loop` CLI flag and update documentation.

### Changes Required

#### 1. Update CLI Argument Parsing

**File**: `src/cli.tsx`
**Location**: Line 32 (add to ParsedArgs interface)

```typescript
interface ParsedArgs {
  command: string | undefined;
  port: string;
  key: string;
  msg: string;
  headless: boolean;
  dryRun: boolean;
  restore: boolean;
  yes: boolean;
  yolo: boolean;
  systemPrompt: string;
  systemPromptFile: string;
  additionalArgs: string[];
  aiLoop: boolean; // NEW
}
```

**Location**: Line 47 (add to defaults in parseArgs)

```typescript
let aiLoop = false;
```

**Location**: After line 83 (add flag handling in parseArgs)

```typescript
} else if (arg === "--ai-loop") {
  aiLoop = true;
}
```

**Location**: Line 99 (add to return object)

```typescript
return {
  command,
  port,
  key,
  msg,
  headless,
  dryRun,
  restore,
  yes,
  yolo,
  systemPrompt,
  systemPromptFile,
  additionalArgs,
  aiLoop, // NEW
};
```

#### 2. Update WorkerRunner and LeadRunner Components

**File**: `src/cli.tsx`
**Location**: Line 432 (update RunnerProps interface)

```typescript
interface RunnerProps {
  prompt: string;
  yolo: boolean;
  systemPrompt: string;
  systemPromptFile: string;
  additionalArgs: string[];
  aiLoop: boolean; // NEW
}
```

**Location**: Lines 440-465 (update WorkerRunner)

Add `aiLoop` to the destructured props and pass it to `runWorker`:

```typescript
function WorkerRunner({
  prompt,
  yolo,
  systemPrompt,
  systemPromptFile,
  additionalArgs,
  aiLoop, // NEW
}: RunnerProps) {
  const { exit } = useApp();

  useEffect(() => {
    runWorker({
      prompt: prompt || undefined,
      yolo,
      systemPrompt: systemPrompt || undefined,
      systemPromptFile: systemPromptFile || undefined,
      additionalArgs,
      logsDir: "./logs",
      aiLoop, // NEW
    }).catch((err) => {
      console.error("[error] Worker encountered an error:", err);
      exit(err);
    });
  }, [prompt, yolo, systemPrompt, systemPromptFile, additionalArgs, aiLoop, exit]);

  return null;
}
```

**Location**: Lines 467-486 (update LeadRunner similarly)

#### 3. Update Switch Statement

**File**: `src/cli.tsx`
**Location**: Lines 540-559 (update worker and lead cases)

```typescript
case "worker":
  return (
    <WorkerRunner
      prompt={msg}
      yolo={yolo}
      systemPrompt={systemPrompt}
      systemPromptFile={systemPromptFile}
      additionalArgs={additionalArgs}
      aiLoop={aiLoop} // NEW
    />
  );
case "lead":
  return (
    <LeadRunner
      prompt={msg}
      yolo={yolo}
      systemPrompt={systemPrompt}
      systemPromptFile={systemPromptFile}
      additionalArgs={additionalArgs}
      aiLoop={aiLoop} // NEW
    />
  );
```

#### 4. Update Help Text

**File**: `src/cli.tsx`
**Location**: After line 255 (add --ai-loop to worker/lead options)

```tsx
<Box>
  <Box width={30}>
    <Text color="yellow">--ai-loop</Text>
  </Box>
  <Text>Use AI-based polling (legacy mode)</Text>
</Box>
```

#### 5. Update Environment Variable Documentation

**File**: `src/cli.tsx`
**Location**: After line 336 (add AI_LOOP env var)

```tsx
<Box>
  <Box width={24}>
    <Text color="magenta">AI_LOOP</Text>
  </Box>
  <Text>If "true", use AI-based polling</Text>
</Box>
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles without errors: `bun run tsc:check`
- [x] Linting passes: `bun run lint`
- [x] `bun run worker --help` shows `--ai-loop` option

#### Manual Verification:
- [ ] `bun run worker` defaults to runner-level polling
- [ ] `bun run worker --ai-loop` uses AI-based polling
- [ ] `AI_LOOP=true bun run worker` uses AI-based polling
- [ ] `bun run lead` defaults to runner-level polling
- [ ] `bun run lead --ai-loop` uses AI-based polling

---

## Testing Strategy

### Unit Tests

No new unit tests required - this is primarily integration behavior.

### Integration Tests

Create a test script to verify the polling mechanism:

```bash
#!/bin/bash
# test-runner-polling.sh

# Start MCP server in background
bun run mcp &
MCP_PID=$!
sleep 2

# Start worker with runner-level polling
AGENT_ID=test-worker SWARM_URL=http://localhost:3013 timeout 10 bun run worker &
WORKER_PID=$!
sleep 3

# Create a task
curl -X POST http://localhost:3013/api/tasks \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: lead-agent" \
  -d '{"task": "Test task", "agentId": "test-worker"}'

# Wait for worker to pick up task
sleep 5

# Cleanup
kill $WORKER_PID $MCP_PID 2>/dev/null
```

### Manual Testing Steps

1. Start MCP server: `bun run mcp`
2. Start worker in new terminal: `AGENT_ID=test-worker SWARM_URL=http://localhost:3013 bun run worker`
3. Observe: Worker should log "Polling for triggers..." and wait
4. Create a task via dashboard or API
5. Observe: Worker should log trigger received and spawn Claude
6. Test `--ai-loop` mode works as before

## Performance Considerations

- **Reduced token consumption**: Claude only spawned when there's work (major savings)
- **Poll interval**: 2 seconds is reasonable; can be tuned via env var if needed
- **Poll timeout**: 1 minute before retry loop; keeps connections fresh
- **HTTP overhead**: Minimal compared to Claude session costs

## Migration Notes

- **Backwards compatible**: `--ai-loop` flag preserves existing behavior
- **No database changes**: Uses existing tables and queries
- **No breaking changes**: Existing commands work as before

## References

- Related research: `thoughts/shared/research/2025-12-22-runner-loop-architecture.md`
- Runner implementation: `src/commands/runner.ts:138-258`
- HTTP API: `src/http.ts:72-583`
- CLI parsing: `src/cli.tsx:38-101`
- Poll-task MCP tool: `src/tools/poll-task.ts`
- Work-on-task command: `plugin/commands/work-on-task.md`
- Review-offered-task command (NEW): `plugin/commands/review-offered-task.md`
