-- Task leases: replace at-most-once execution with at-least-once + bounded retries.
--
-- Upstream behaviour: when a worker's heartbeat went stale, the task was moved
-- straight to 'failed' and the work was lost. There was no lease, no attempt
-- counter, and no requeue path, so a worker crash silently destroyed in-flight
-- work and a human (or the lead agent's prompt) had to notice and re-file it.
--
-- This migration introduces an explicit lease on claimed tasks:
--   * attempts        — how many times the task has been claimed
--   * maxAttempts     — retry budget before the task is parked
--   * leaseExpiresAt  — wall-clock deadline the owning worker must renew past
--   * leaseOwnerId    — which agent currently holds the lease
--
-- A reaper requeues tasks whose lease has expired (status -> 'unassigned') until
-- the retry budget is exhausted, at which point the task moves to the new
-- terminal status 'dead_letter' for inspection instead of being buried in
-- 'failed' alongside genuine task failures.
--
-- Note: agent_tasks.status has no CHECK constraint (see migration 056), so the
-- new 'dead_letter' status needs no table rebuild.

ALTER TABLE agent_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN maxAttempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE agent_tasks ADD COLUMN leaseExpiresAt TEXT;
ALTER TABLE agent_tasks ADD COLUMN leaseOwnerId TEXT;

-- The reaper scans for expired leases on every sweep; keep it index-driven.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_lease_expiry
  ON agent_tasks(leaseExpiresAt)
  WHERE leaseExpiresAt IS NOT NULL;

-- Dead-lettered tasks are listed in the dashboard and by `apiary task dlq`.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_dead_letter
  ON agent_tasks(status)
  WHERE status = 'dead_letter';

-- Tasks already in flight at upgrade time have been claimed exactly once.
UPDATE agent_tasks SET attempts = 1 WHERE status IN ('in_progress', 'paused');
