---
date: 2025-12-22T01:20:00-08:00
researcher: Claude Opus 4.5
git_commit: 4334e7c
branch: main
repository: agent-swarm
topic: "Setup Experience & Demo Ideas"
tags: [research, developer-experience, onboarding, demo]
status: complete
last_updated: 2025-12-22
last_updated_by: Claude Opus 4.5
---

# Research: Setup Experience & Demo Ideas

**Date**: 2025-12-22T01:20:00-08:00
**Researcher**: Claude Opus 4.5
**Git Commit**: 4334e7c
**Branch**: main
**Repository**: agent-swarm

## Research Question

How to make the project super easy to setup and run for someone that clones or wants to try it out locally or deploy it? What are ideas for a demo?

## Summary

The project has solid infrastructure but the onboarding experience could be significantly improved. The main barriers are: (1) scattered documentation with no true "30-second quick start", (2) UI and server require separate setup, (3) Claude OAuth token requirement is a major barrier for new users, and (4) no simple demo to understand what the project does. Below are specific recommendations and demo ideas.

## Current Project Structure

```
agent-swarm/
├── src/                    # MCP Server + CLI
│   ├── http.ts            # HTTP MCP server (main backend)
│   ├── stdio.ts           # STDIO transport
│   ├── cli.tsx            # CLI entry (setup, worker, lead, hook)
│   ├── commands/          # CLI command implementations
│   └── tools/             # MCP tool handlers
├── ui/                    # Separate Vite dashboard (MUI Joy + React)
│   ├── src/               # React components
│   └── package.json       # Separate deps (uses pnpm)
├── plugin/                # Claude Code plugin (not yet published)
├── deploy/                # Deployment scripts (systemd, Docker)
├── Dockerfile.worker      # Worker container with full dev env
└── docker-compose.*.yml   # Docker compose configs
```

## Current Setup Experience Gaps

### 1. Prerequisites Not Prominent
- Bun is required but mentioned only in passing
- No clear version requirements
- Node.js 22 mentioned for Docker only

### 2. No Unified Quick Start
Current README jumps straight to `bunx @desplega.ai/agent-swarm@latest setup` which:
- Assumes user has Bun installed
- Requires API token from cloud service
- Doesn't work for local development

### 3. UI Requires Separate Setup
```bash
# User must know to:
cd ui
pnpm install  # Note: different package manager!
pnpm dev      # Separate terminal
```

### 4. Missing "All-in-One" Development Script
No single command to start both server and UI with hot reload.

### 5. Claude OAuth Token Barrier
Biggest friction: requires `CLAUDE_CODE_OAUTH_TOKEN` which is:
- Hard to obtain (undocumented process)
- Required even for basic testing
- Blocks casual exploration

### 6. No Simple "See It Work" Demo
Users can't quickly see value without significant setup.

## Improvement Recommendations

### 1. Add Prerequisites Section (Top of README)

```markdown
## Prerequisites

- [Bun](https://bun.sh) v1.1+ (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code CLI](https://claude.ai/install.sh) (for running agents)
- Docker (optional, for containerized workers)
```

### 2. Add True Quick Start (Local Development)

```markdown
## Quick Start (Local Development)

# 1. Clone and install
git clone https://github.com/desplega-ai/agent-swarm.git
cd agent-swarm
bun install

# 2. Create .env file
cp .env.example .env
# Edit .env to set API_KEY=any-secret-you-want

# 3. Start the MCP server
bun run dev:http

# Server running at http://localhost:3013

# 4. (Optional) Start the dashboard
cd ui && pnpm install && pnpm dev
# Dashboard at http://localhost:5173
```

### 3. Add `dev:all` Script to package.json

```json
"scripts": {
  "dev:all": "bun run dev:http & (cd ui && pnpm dev)",
  "dev:ui": "cd ui && pnpm dev"
}
```

Or use a process manager approach:
```bash
# Add to package.json scripts
"dev:all": "bun --hot src/http.ts & cd ui && pnpm dev"
```

### 4. Add MCP Inspector Demo Mode

For users who just want to see it work without Claude:

```markdown
## Try Without Claude

Test the MCP tools using the inspector:

bun run inspector:http

This opens a web UI where you can:
- Call `join-swarm` to register an agent
- Use `send-task` to create tasks
- See the full API without needing Claude
```

### 5. Create Demo Modes in CLI

Add simple demo commands that simulate swarm behavior:

```bash
# Simulate a 3-agent swarm locally
bunx @desplega.ai/agent-swarm demo --agents 3

# This would:
# 1. Start local server
# 2. Register 3 fake agents
# 3. Create sample tasks
# 4. Show agents claiming and completing tasks
```

### 6. Add Screencast/GIF to README

A 30-second GIF showing:
1. Dashboard with agents
2. Tasks being assigned
3. Real-time progress updates
4. Agent messaging

### 7. Environment File Consolidation

Create a single `.env.development.example`:
```env
# Local Development Configuration
API_KEY=dev-secret-key
PORT=3013
SWARM_URL=localhost

# Only needed for actual Claude agents:
# CLAUDE_CODE_OAUTH_TOKEN=your-token
```

## Demo Ideas

### Demo 1: Task Coordination Screencast (Simplest)
**Setup**: 1 lead + 2 workers
**Scenario**: Lead breaks down "Build a calculator" into tasks:
- Worker 1: Implement add/subtract
- Worker 2: Implement multiply/divide
- Both report progress, lead monitors

**Why it works**: Shows core value prop - parallel execution with coordination

### Demo 2: Code Review Swarm (Practical)
**Setup**: 1 lead + 3 specialized workers
**Scenario**: Review a PR from multiple angles:
- Worker 1: Security review
- Worker 2: Performance review
- Worker 3: Test coverage review
- Lead synthesizes findings

**Why it works**: Immediately useful, shows specialization

### Demo 3: Research Swarm (Impressive)
**Setup**: 1 lead + 3 researchers
**Scenario**: Research "Best practices for X" topic:
- Workers search different sources in parallel
- Post findings to shared channel
- Lead synthesizes into final report

**Why it works**: Shows messaging + parallel speedup

### Demo 4: Service Registry Demo (Technical)
**Setup**: 2 workers with background services
**Scenario**:
- Worker 1: Starts an API server (PM2 + register-service)
- Worker 2: Discovers and calls Worker 1's API
- Shows cross-agent service communication

**Why it works**: Demonstrates unique capability

### Demo 5: Interactive Dashboard Demo
**No Claude needed**
**Scenario**: Use the MCP Inspector to:
1. Register 3 agents manually
2. Create tasks in the pool
3. Claim tasks as different agents
4. Show dashboard updating in real-time

**Why it works**: Zero barrier to entry, visual

## Recommended Demo Implementation Priority

1. **Demo 5 (Dashboard Demo)** - Zero friction, can be a video on README
2. **Demo 1 (Task Coordination)** - Core value, simple script
3. **Demo 2 (Code Review)** - Practical application
4. **Demo 3 (Research)** - Shows advanced features

## Quick Wins

1. Add `bun run dev:all` script
2. Move Prerequisites to top of README
3. Add "Try Without Claude" section
4. Record 30-second GIF for README
5. Create `.env.development.example` with comments

## Related Files

- `README.md` - Main documentation
- `deploy/DEPLOY.md` - Server deployment docs
- `.env.example` - Server environment template
- `.env.docker.example` - Docker environment template
- `src/cli.tsx` - CLI entry point
- `ui/` - Dashboard application

## Open Questions

1. Can we publish a "demo mode" that doesn't require OAuth?
2. Should UI be embedded in main server (single port)?
3. Is there a way to provide temporary Claude tokens for demos?
4. Should there be a hosted demo instance users can connect to?
