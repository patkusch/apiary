<h1 align="center">apiary</h1>

<p align="center">
  <b>Durable multi-agent orchestration for coding agents.</b><br/>
  <sub>Leased tasks. Bounded retries. No work lost when a worker dies.</sub>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/tests-3753%20passing-brightgreen?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/runtime-bun-black?style=flat-square" alt="Bun">
</p>

---

## What this is

apiary is a hard fork of [`desplega-ai/agent-swarm`](https://github.com/desplega-ai/agent-swarm)
(MIT), by way of [`jamalavedra/agent-swarm`](https://github.com/jamalavedra/agent-swarm).
It keeps the parts of that project that are genuinely good — the lead/worker model,
the priority pool, budget admission control, encrypted secrets, workflows — and
changes the parts that are not.

It is a fork, not a rewrite. Upstream did the hard work of building the surface
area; this fork is opinionated about correctness and scope.

## Why fork

Three things motivated it.

### 1. A crashed worker destroyed its task

Upstream had no lease on a claimed task. When a worker's heartbeat went stale,
the heartbeat sweep called `failTask()` and the in-flight work was gone. There
was no attempt counter and no requeue path, so a crash — or an ordinary deploy
restart — silently discarded work. Upstream's own heartbeat prompt told the lead
agent to go clean up after it:

> Failures with reason "worker session not found" or "worker session heartbeat is
> stale" indicate tasks that were INTERRUPTED by a server restart. These are NOT
> "expected auto-cleanup" — they represent work that was lost mid-execution.

That is a missing state machine papered over with an LLM prompt. apiary replaces
it with an explicit lease:

- `claimTask()` takes a lease and increments an attempt counter.
- The worker's session heartbeat renews the lease, guarded on lease ownership so
  a reaped worker can't resurrect a claim that has moved on.
- A lapsed lease means *nobody is working on this*, which is a scheduling fact,
  not a task failure. The task goes back to `unassigned` for another worker.
- Only once the retry budget is spent does the task move to a new terminal
  status, `dead_letter`, so a poison task can't spin forever and a transient
  crash can't lose work.

At-most-once became at-least-once with a bounded retry budget. See
[`src/tests/task-leases.test.ts`](src/tests/task-leases.test.ts), which kills a
worker mid-task and proves the work survives.

### 2. The persistence layer called the network

`db.ts` imported `../github/task-reactions`, so `claimTask()` — a SQLite write
path — fired an HTTP request to GitHub. The data layer depended on GitHub and
Slack and could not be exercised without mocking the internet.

Task lifecycle notifications now go through an in-process hook registry
([`src/be/task-hooks.ts`](src/be/task-hooks.ts)) that integrations subscribe to at
startup ([`src/be/wiring.ts`](src/be/wiring.ts)). Behaviour is unchanged; the
coupling is gone. A listener that throws can no longer affect the database write
that triggered it.

### 3. The headline claim was never measured

Upstream's pitch is that agents "remember everything, learn from every mistake,
and get better with every task." There is no retrieval benchmark, no ablation,
and no task-success metric anywhere in the project — 219 test files, none of
which measure whether memory helps. The central value proposition ships
unfalsifiable.

Making that measurable is the main roadmap item for this fork (see below). If
compounding memory works, it should be possible to show it.

## Status

**v0.1.0** — the durability and layering work is done and covered by tests. The
full inherited suite passes: **3753 tests, 0 failures**.

| Area | State |
|---|---|
| Task leases, retries, dead-letter queue | ✅ Done, tested |
| Network I/O out of the persistence layer | ✅ Done |
| Renamed / rescoped from agent-swarm | ✅ Done |
| Memory eval harness (`apiary eval`) | ⬜ Next |
| Strip crypto-wallet scope (`src/x402`) | ⬜ Next |
| Break up the 9.4k-line `db.ts` into repositories | ⬜ Planned |

### Planned: `apiary eval`

A golden retrieval set with hit@k / MRR, plus an A/B ablation runner that runs a
task suite with memory on versus off and reports the delta. This is the feature
that would turn "agents get better over time" from a claim into a number.

### Planned: dropping the wallet

Upstream ships `src/x402/`, which takes a raw `EVM_PRIVATE_KEY` from the
environment to make crypto payments. A tool that holds repository write access
should not also hold a hot wallet key. That module is slated for removal, along
with the Openfort and viem dependencies.

## Quick start

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.0.26, and a Claude Code OAuth token
(`claude setup-token`). Docker is needed only for containerised workers.

```bash
bun install
```

```bash
bun test
```

```bash
bun run start:http
```

The API listens on port `3013`, with interactive docs at `http://localhost:3013/docs`.

Configuration, deployment, and integration setup are inherited from upstream and
documented in [DEPLOYMENT.md](./DEPLOYMENT.md) and [LOCAL_TESTING.md](./LOCAL_TESTING.md).
Upstream's docs at [docs.agent-swarm.dev](https://docs.agent-swarm.dev) still
apply to everything this fork has not changed.

## Lease configuration

| Variable | Default | Meaning |
|---|---|---|
| `TASK_LEASE_DURATION_MS` | `600000` (10 min) | How long a claim is valid without renewal. Must comfortably exceed the worker session heartbeat interval. |

Retry budget is per-task via `maxAttempts` (default `3`). Dead-lettered tasks are
listed by `getDeadLetterTasks()` and can be returned to the pool with a fresh
budget via `requeueDeadLetterTask()`.

## Credit

The overwhelming majority of this code was written by the
[desplega.sh](https://desplega.sh) team and contributors to
[`desplega-ai/agent-swarm`](https://github.com/desplega-ai/agent-swarm), and by
[Jaume Alavedra](https://github.com/jamalavedra), whose fork contributed the fix
for a recursive Stop-hook fork bomb. This fork stands on that work and remains
MIT licensed with the original copyright intact.

The critique above is a critique of specific engineering decisions, not of the
project or the people who built it. Shipping something this broad is hard, and
most of it is well made.

## License

[MIT](./LICENSE) — original copyright © 2025–2026 desplega.sh; fork modifications
© 2026 patkusch.
