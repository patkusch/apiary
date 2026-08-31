<h1 align="center">apiary</h1>

<p align="center">
  <b>Durable multi-agent orchestration for coding agents.</b><br/>
  <sub>Leased tasks. Bounded retries. No work lost when a worker dies.</sub>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/tests-3745%20passing-brightgreen?style=flat-square" alt="Tests">
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

`apiary eval` fixes that: it scores retrieval against a labelled golden set and
prints hit@k, recall@k, precision@k, nDCG@k and MRR (see below). Retrieval
quality is now a number that moves when the code changes, and a CI gate can
refuse a regression. Whether memory improves *task outcomes* is a further step,
and is still open.

## Status

**v0.1.0** — durability, layering, scope reduction and the eval harness are done
and covered by tests. Full suite: **3745 tests, 0 failures**.

| Area | State |
|---|---|
| Task leases, retries, dead-letter queue | ✅ Done, tested |
| Network I/O out of the persistence layer | ✅ Done |
| Reclaimed tasks no longer returned to dead workers | ✅ Done, tested |
| Crypto-wallet scope removed (`src/x402`) | ✅ Done |
| Memory eval harness (`apiary eval`) | ✅ Done, tested |
| `dead_letter` treated as terminal everywhere | ✅ Done, tested |
| Server restart reclaims leases instead of cloning tasks | ✅ Done, tested |
| Fencing token so a reclaimed worker cannot still write | ⬜ Open, see Known limitations |
| Leases on the direct-assign path (`startTask`/`resumeTask`) | ⬜ Open, see Known limitations |
| End-to-end memory ablation (task success with memory on/off) | ⬜ Next |
| Break up the 9.4k-line `db.ts` into repositories | ⬜ Planned |

### `apiary eval`

```bash
bun src/cli.tsx eval
```

Seeds a golden corpus into the real memory store, runs each labelled query
through the same retrieval path the agents use, and scores the ranking:

```
  Golden set    engineering-memories
  Embeddings    hash-bow-v1 (512d)
  Corpus        20 documents, 16 queries

  k      hit@k    recall@k  prec@k   nDCG@k
  ----   ------   --------  ------   ------
  1       31.3%      28.1%   31.3%    31.3%
  3       75.0%      75.0%   27.1%    57.2%
  5       81.3%      81.3%   17.5%    59.6%
  10      87.5%      87.5%    9.4%    61.7%

  MRR           0.532
```

It runs against a throwaway database, so it can never read or pollute a live
swarm's memories, and misses are printed with the documents that were expected
so a regression is diagnosable rather than just a lower number.

The default embedding provider is a deterministic hashed bag-of-words
projection. That is a deliberate trade: the production embedder calls the OpenAI
API, which needs a key, costs money per run, and drifts when the upstream model
changes — an eval you cannot run on every commit is an eval nobody runs. It sees
lexical overlap only, so **treat its scores as a floor, not as production
quality**; `--provider openai` gives real numbers. Both current misses on the
built-in set are queries that need synonymy the lexical provider cannot see.

| Flag | Meaning |
|---|---|
| `--set <path>` | Use your own golden set JSON |
| `--provider hash\|openai` | Embeddings (default `hash`, offline) |
| `--json` | Emit the full report for CI |
| `--min-hit-at K=F` | Exit non-zero if hit@K drops below fraction F |

Still missing, and the honest gap: this measures *retrieval*, not whether
memory makes agents finish tasks better. End-to-end ablation is the next step.

### Removed: the wallet

Upstream shipped `src/x402/`, which read a raw `EVM_PRIVATE_KEY` from the
environment to make crypto payments. A tool that holds repository write access
and executes agent-authored code should not also hold a hot wallet key. The
module is gone, along with the `@x402/*`, Openfort and viem dependencies.

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

## Known limitations

Each of these has been confirmed in the code or by running it. Nothing here is
speculative.

**Leases have no fencing token.** Renewal is driven by the `PostToolUse` hook, so
the cadence is however often the agent calls a tool, not a timer. A worker inside
one long build or one slow model turn can exceed `TASK_LEASE_DURATION_MS` while
still healthy, lose its lease, and have the task requeued underneath it.
`completeTask()` takes no agent id and does not check `leaseOwnerId`, so the
original process can still write results for a task another worker now owns. The
database guarantees one claim at a time. The system does not yet guarantee one
worker at a time.

**The direct-assign path takes no lease.** `claimTask()` leases and counts
attempts. `startTask()` and `resumeTask()` do not: they set `in_progress` with a
null lease and never increment `attempts`. Those tasks are still recovered by the
heartbeat stall detector, but they are not bounded by the retry budget, because
the counter never moves.

**`dead_letter` has no API or UI surface.** `getDeadLetterTasks()` and
`requeueDeadLetterTask()` exist and are tested, but nothing outside the test
suite calls them. A dead-lettered task is not visible in the dashboard and cannot
be requeued without a direct database call.

**sqlite-vec does not load on macOS or on CI.** Both print
`sqlite-vec not available, falling back to in-memory cosine`, so every similarity
search runs the brute-force O(n) path. The indexed path exists but is exercised
in neither environment. The `apiary eval` figures above are measuring the
fallback.

**The default database file is still `agent-swarm-db.sqlite`.** The rename to
apiary was never applied to the default path.

**Inherited and unverified.** The following came from upstream and have not been
run by me: the Docker lead and worker images, the dashboard UI, and
`apiary eval --provider openai`. `package.json` declares `bun >=1.0.26`; the only
version this has been run on is 1.4.0. Dependencies use caret ranges, so
reproducibility depends on the committed `bun.lock` and `--frozen-lockfile`.

**Upstream leftovers.** `CHANGELOG.md` is 100 KB of upstream release history for
versions this fork never shipped. `thoughts/` and `designs/` are upstream's
internal notes, including research on the x402 module this fork removed.

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
