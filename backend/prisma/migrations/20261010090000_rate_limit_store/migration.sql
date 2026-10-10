-- Shared counters for express-rate-limit.
--
-- The default MemoryStore keeps counters inside each process. On Vercel every
-- function instance then enforces its own budget, so the effective limit grows
-- with the number of warm instances and resets whenever an instance recycles.
-- Storing the counters in Postgres makes the limit global across the deployment.

CREATE TABLE rate_limit_hits (
  key        text        PRIMARY KEY,
  hits       integer     NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supports the periodic cleanup of expired rows.
CREATE INDEX rate_limit_hits_expires_at_idx ON rate_limit_hits (expires_at);

-- Invariant: a counter is never negative (the store only decrements on success).
ALTER TABLE rate_limit_hits
  ADD CONSTRAINT rate_limit_hits_hits_non_negative CHECK (hits >= 0);
