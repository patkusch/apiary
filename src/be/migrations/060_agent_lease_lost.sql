-- Remember which workers just lost a task lease.
--
-- When a worker goes silent and its lease expires, the task goes back to the
-- pool. Until now the silent worker's status stayed "idle" (or flipped back to
-- it on the next health check), and the heartbeat hands pool tasks to the first
-- idle worker in registration order. So the task could go straight back to the
-- worker that had just failed to finish it, and burn one of its three attempts
-- on a process that was not there to take it.
--
-- leaseLostAt is set on the previous holder when its lease is reclaimed. While
-- it is set the worker is not offered pool tasks and does not count as a healthy
-- idle worker. It is cleared by the worker's next sign of life: a /ping, a
-- /api/poll, or registering again. NULL means nothing is wrong.

ALTER TABLE agents ADD COLUMN leaseLostAt TEXT;
