---
date: 2025-12-21T21:10:00-08:00
researcher: master lord
git_commit: fb757dbc76fc9f3c6f5859d4a96c28af4dc02af9
branch: main
repository: agent-swarm
topic: "Gemini CLI Integration Research"
tags: [research, codebase, gemini-cli, multi-cli, integration]
status: complete
last_updated: 2025-12-21
last_updated_by: master lord
---

# Research: Gemini CLI Integration

**Date**: 2025-12-21T21:10:00-08:00
**Researcher**: master lord
**Git Commit**: fb757dbc76fc9f3c6f5859d4a96c28af4dc02af9
**Branch**: main
**Repository**: agent-swarm

## Research Question

How can we integrate the agent-swarm codebase with other CLI tools, particularly Gemini CLI, to support Gemini 3 and other models alongside Claude?

## Summary

The agent-swarm codebase has a clean separation between **CLI-agnostic** components (MCP server, tools, database) and **Claude-specific** components (CLI spawning, hooks, setup). Integration with Gemini CLI is feasible because:

1. **MCP Server works as-is** - Gemini CLI fully supports MCP servers via the same protocol
2. **Headless mode is similar** - Both CLIs support `--output-format stream-json` and prompt flags
3. **Hooks exist in both** - Different event names but similar JSON stdin/stdout protocol
4. **Authentication is straightforward** - Gemini uses API keys or service accounts, easy for containers

The main work involves creating an abstraction layer in the runner to support multiple CLI tools.

## Detailed Findings

### Current Architecture: CLI-Specific vs CLI-Agnostic Components

| Component | File | CLI Dependency | Notes |
|-----------|------|----------------|-------|
| MCP Server | `src/server.ts` | **CLI-agnostic** | Standard MCP SDK, works with any client |
| MCP Tools | `src/tools/*.ts` | **CLI-agnostic** | Pure MCP protocol |
| HTTP Transport | `src/http.ts` | **CLI-agnostic** | Standard MCP HTTP transport |
| STDIO Transport | `src/stdio.ts` | **CLI-agnostic** | Standard MCP STDIO transport |
| Database Layer | `src/be/db.ts` | **CLI-agnostic** | SQLite operations |
| Type Definitions | `src/types.ts` | **CLI-agnostic** | Data structures |
| CLI Spawner | `src/claude.ts` | **Claude-specific** | Hardcoded `claude` command |
| Agent Runner | `src/commands/runner.ts` | **Claude-specific** | Claude CLI flags |
| Hook Handler | `src/hooks/hook.ts` | **Claude-specific** | Claude Code hook protocol |
| Setup Command | `src/commands/setup.tsx` | **Claude-specific** | Creates `.claude/` config |
| Docker Files | `Dockerfile.worker` | **Claude-specific** | Installs Claude CLI |

### Claude CLI Integration Points

**1. CLI Spawning (`src/claude.ts:9-80`)**
```typescript
const CMD = ["claude"];  // Hardcoded CLI name
if (opts.headless) {
  CMD.push("--verbose");
  CMD.push("--output-format");
  CMD.push("stream-json");
  CMD.push("-p");
  CMD.push(opts.msg);
}
```

**2. Agent Runner (`src/commands/runner.ts:65-92`)**
```typescript
const CMD = [
  "claude",
  "--verbose",
  "--output-format", "stream-json",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode", "bypassPermissions",
  "-p", opts.prompt,
];
if (opts.systemPrompt) {
  CMD.push("--append-system-prompt", opts.systemPrompt);
}
```

**3. Hook Events (`src/hooks/hook.ts`)**
- `SessionStart`
- `PreCompact`
- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `Stop`

---

## Authentication Comparison

### Claude Code

| Method | Environment Variable | Notes |
|--------|---------------------|-------|
| OAuth Token | `CLAUDE_CODE_OAUTH_TOKEN` | Used in Docker workers |
| API Key | Not directly supported | Uses Anthropic account auth |

### Gemini CLI

| Method | Environment Variables | Best For |
|--------|----------------------|----------|
| **API Key** | `GEMINI_API_KEY` | Simple automation, quick setup |
| **Service Account** | `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` | Docker, CI/CD, containers |
| **ADC (gcloud)** | `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` | Local dev with gcloud installed |
| **OAuth** | Browser login, cached at `~/.gemini/` | Interactive local use |
| **Cloud API Key** | `GOOGLE_API_KEY` + `GOOGLE_CLOUD_PROJECT` | Vertex AI access |

### Key Auth Behaviors

**Auto .env loading**: Gemini CLI automatically loads environment variables from:
1. `.gemini/.env` in project directory (first found going up)
2. `~/.gemini/.env`
3. `~/.env`

This is similar to Bun's `.env` loading behavior.

**Headless auth**: For containers/automation, use either:
- `GEMINI_API_KEY` - Simplest, just set the API key
- Service account JSON file mounted + `GOOGLE_APPLICATION_CREDENTIALS` path

### Docker Auth Mapping

| Current (Claude) | Gemini Equivalent |
|------------------|-------------------|
| `CLAUDE_CODE_OAUTH_TOKEN` env | `GEMINI_API_KEY` env |
| Token validation at startup | API key validation at startup |
| N/A | Service account JSON mount option |

For multi-CLI Docker support, the entrypoint would check:
```bash
if [ "$CLI_TOOL" = "gemini" ]; then
  if [ -z "$GEMINI_API_KEY" ] && [ -z "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
    echo "Error: GEMINI_API_KEY or GOOGLE_APPLICATION_CREDENTIALS required"
    exit 1
  fi
elif [ "$CLI_TOOL" = "claude" ]; then
  if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    echo "Error: CLAUDE_CODE_OAUTH_TOKEN required"
    exit 1
  fi
fi
```

---

## Gemini CLI Feature Comparison

### Headless Mode Flags

| Feature | Claude CLI | Gemini CLI |
|---------|------------|------------|
| Prompt flag | `-p <message>` | `--prompt <message>` |
| JSON output | `--output-format stream-json` | `--output-format stream-json` |
| Verbose mode | `--verbose` | N/A |
| Auto-approve | `--dangerously-skip-permissions` | `--yolo` |
| Model selection | N/A | `--model <name>` |
| Approval mode | `--permission-mode bypassPermissions` | `--approval-mode <mode>` |
| System prompt | `--append-system-prompt` | `GEMINI_SYSTEM_MD` env var |

### MCP Server Configuration

**Claude Code (`.mcp.json`):**
```json
{
  "mcpServers": {
    "agent-swarm": {
      "command": "bunx",
      "args": ["@desplega.ai/agent-swarm@latest", "mcp", "stdio"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

**Gemini CLI (`settings.json`):**
```json
{
  "mcpServers": {
    "agent-swarm": {
      "command": "bunx",
      "args": ["@desplega.ai/agent-swarm@latest", "mcp", "stdio"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

Nearly identical! Both follow the MCP specification.

### Hook Events Mapping

| Claude Code | Gemini CLI | Notes |
|-------------|------------|-------|
| `SessionStart` | `SessionStart` | Same |
| `Stop` | `SessionEnd` | Different name |
| `PreToolUse` | `BeforeTool` | Different name |
| `PostToolUse` | `AfterTool` | Different name |
| `UserPromptSubmit` | `BeforeAgent` | Similar concept |
| `PreCompact` | `PreCompress` | Different name |
| N/A | `BeforeModel` / `AfterModel` | Gemini-only |
| N/A | `BeforeToolSelection` | Gemini-only |
| N/A | `Notification` | Gemini-only |

### Custom Commands

| Feature | Claude Code | Gemini CLI |
|---------|-------------|------------|
| Format | Markdown | TOML |
| Location | `.claude/commands/` | `.gemini/commands/` |
| Invocation | `/command-name` | `/command-name` |
| Arguments | Passed to prompt | `{{args}}` placeholder |
| Namespacing | Flat | Colon-separated (`/git:commit`) |

---

## Integration Architecture

### Option 1: CLI Adapter Pattern

Create an abstraction layer that normalizes CLI differences:

```typescript
// src/adapters/types.ts
interface CLIAdapter {
  name: string;
  command: string;
  buildArgs(opts: RunOptions): string[];
  parseOutput(line: string): ParsedOutput;
  hookEventMap: Record<string, string>;
  authEnvVars: string[];
}

// src/adapters/claude-adapter.ts
export const claudeAdapter: CLIAdapter = {
  name: "claude",
  command: "claude",
  authEnvVars: ["CLAUDE_CODE_OAUTH_TOKEN"],
  buildArgs: (opts) => [
    "--verbose",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode", "bypassPermissions",
    "-p", opts.prompt,
    ...(opts.systemPrompt ? ["--append-system-prompt", opts.systemPrompt] : []),
  ],
  parseOutput: (line) => JSON.parse(line),
  hookEventMap: {
    SessionStart: "SessionStart",
    Stop: "Stop",
    PreToolUse: "PreToolUse",
    PostToolUse: "PostToolUse",
  },
};

// src/adapters/gemini-adapter.ts
export const geminiAdapter: CLIAdapter = {
  name: "gemini",
  command: "gemini",
  authEnvVars: ["GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
  buildArgs: (opts) => [
    "--output-format", "stream-json",
    "--yolo",
    "--prompt", opts.prompt,
  ],
  // System prompt handled via GEMINI_SYSTEM_MD env var
  parseOutput: (line) => JSON.parse(line),
  hookEventMap: {
    SessionStart: "SessionStart",
    Stop: "SessionEnd",
    PreToolUse: "BeforeTool",
    PostToolUse: "AfterTool",
  },
};
```

### Option 2: Configuration-Driven

Add CLI tool configuration to environment/settings:

```typescript
interface CLIConfig {
  command: string;
  headlessFlags: string[];
  autoApproveFlag: string;
  promptFlag: string;
  systemPromptFlag?: string;
  systemPromptEnv?: string;
  outputFormatFlag: string[];
  authEnvVars: string[];
}

const CLI_CONFIGS: Record<string, CLIConfig> = {
  claude: {
    command: "claude",
    headlessFlags: ["--verbose"],
    autoApproveFlag: "--dangerously-skip-permissions",
    promptFlag: "-p",
    systemPromptFlag: "--append-system-prompt",
    outputFormatFlag: ["--output-format", "stream-json"],
    authEnvVars: ["CLAUDE_CODE_OAUTH_TOKEN"],
  },
  gemini: {
    command: "gemini",
    headlessFlags: [],
    autoApproveFlag: "--yolo",
    promptFlag: "--prompt",
    systemPromptEnv: "GEMINI_SYSTEM_MD",
    outputFormatFlag: ["--output-format", "stream-json"],
    authEnvVars: ["GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
  },
};
```

### Files Requiring Changes

| File | Change Required |
|------|-----------------|
| `src/claude.ts` | Rename to `src/cli-runner.ts`, add adapter support |
| `src/commands/runner.ts` | Use CLI adapter instead of hardcoded flags |
| `src/hooks/hook.ts` | Map hook events through adapter |
| `src/commands/setup.tsx` | Generate config for selected CLI |
| `Dockerfile.worker` | Add Gemini CLI installation option |
| `docker-entrypoint.sh` | Handle multiple auth mechanisms |
| `package.json` | Add `gemini` script variants |

### What Works Without Changes

1. **MCP Server** (`src/server.ts`) - Fully CLI-agnostic
2. **All MCP Tools** (`src/tools/*.ts`) - Pure MCP protocol
3. **Database Layer** (`src/be/db.ts`) - No CLI awareness
4. **Type Definitions** (`src/types.ts`) - CLI-agnostic data structures
5. **HTTP/STDIO Transports** - Standard MCP SDK

---

## Code References

- `src/claude.ts:9-80` - Claude CLI spawning wrapper
- `src/commands/runner.ts:65-192` - Agent runner with CLI flags
- `src/hooks/hook.ts:56-306` - Hook event handler
- `src/server.ts:42-96` - CLI-agnostic MCP server
- `src/commands/setup.tsx:56-76` - Claude-specific setup
- `Dockerfile.worker:76-98` - Claude CLI installation

## Limitations

| Feature | Claude Code | Gemini CLI | Impact |
|---------|-------------|------------|--------|
| Plugin system | Full support | Extensions (different API) | Commands need porting |
| Agents | Supported | Not mentioned | May not work |
| Skills | Supported | Not mentioned | May not work |
| Context caching | Yes | Yes (token caching) | Works differently |
| Hooks | 6 events | 11 events | Need event mapping |

## Related Research

- `thoughts/shared/research/2025-12-19-agent-log-streaming.md` - Claude CLI JSON streaming format

## Open Questions

1. **JSON streaming format** - Are Claude's and Gemini's stream-json outputs compatible? Both emit newline-delimited JSON but event structures may differ.

2. **Tool name prefixing** - Both CLIs prefix MCP tools. Need to verify `mcp__agent-swarm__*` permission pattern works in Gemini.

3. **Gemini Extensions vs Claude Plugins** - These are different systems. If we want to support Gemini extensions, that's a separate effort.

4. **Model selection** - Gemini CLI supports model switching (`/model`). Should we expose this in agent config?

5. **Quota differences** - Gemini has different quota/pricing. May affect swarm behavior with many agents.
