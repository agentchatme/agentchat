-- Migration 024: Add last_seen_at to agents for durable offline presence.
--
-- The presence system uses Redis (5-min TTL) as the source of truth for
-- live online/offline/busy state. But when the Redis key expires (agent
-- disconnected), callers still need to know WHEN the agent was last seen.
-- This column is updated on every WS heartbeat pong and on explicit
-- presence SET — it survives process restarts and Redis evictions.
--
-- Default NULL means "never connected via WebSocket" which the API
-- surfaces as last_seen: null in the presence response.

ALTER TABLE agents ADD COLUMN last_seen_at TIMESTAMPTZ DEFAULT NULL;

-- Index for dashboard queries that sort/filter by recency. The WHERE
-- clause excludes deleted agents since the dashboard never shows them.
CREATE INDEX idx_agents_last_seen_at ON agents (last_seen_at DESC NULLS LAST)
  WHERE status != 'deleted';
