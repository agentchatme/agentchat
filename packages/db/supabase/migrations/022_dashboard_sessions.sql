-- Dashboard refresh-token sessions. Backs silent refresh + sign-out-everywhere
-- on the owner dashboard. Each row is one active browser session for one
-- owner. The access_token is never persisted — only the refresh_token_hash,
-- so the server can rotate it and so sign-out-everywhere is a single DELETE.
--
-- Why our own table instead of leaning on Supabase's auth.refresh_tokens?
--   1. Sign-out-everywhere: we own the row, `DELETE WHERE owner_id = ?`
--      invalidates every browser in one statement.
--   2. Rotation without SDK state pollution: the service-role Supabase
--      client is deliberately stateless (see packages/db/src/client.ts) so
--      we call POST /auth/v1/token?grant_type=refresh_token directly and
--      pivot on the row we already hold — no SDK session cache involved.
--   3. Decoupling: if we ever swap the Supabase Auth backend, this table
--      and the refresh flow around it stay the same.
--
-- What is NOT stored:
--   - The refresh token itself. Only its SHA-256 hash, so a DB read leak
--     cannot be replayed against Supabase.
--   - The access token. Access tokens are short-lived (1h) and live only
--     in the httpOnly cookie — treating them as session rows would multiply
--     writes by the refresh rate with no security benefit.
--   - User agent / IP. Left out for Phase D1; a future follow-up can add
--     them for the "active sessions" view in account settings without
--     touching the refresh path.

-- ─── 1. dashboard_sessions ─────────────────────────────────────────────────
-- id is a server-generated opaque handle ('dsh_<base64url>') with no
-- embedded secret — the refresh token hash is the secret. The session row
-- id is surfaced nowhere on the wire in Phase D1; it exists so rotation
-- can target a specific row without relying on the hash alone.
CREATE TABLE dashboard_sessions (
  id                 TEXT        PRIMARY KEY,
  owner_id           UUID        NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  refresh_token_hash TEXT        NOT NULL UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sign-out-everywhere path: DELETE FROM dashboard_sessions WHERE owner_id = ?.
-- The lookup on refresh hits the unique index on refresh_token_hash directly,
-- so this extra index exists for the owner-scoped delete and for the future
-- "list my sessions" view.
CREATE INDEX idx_dashboard_sessions_owner ON dashboard_sessions(owner_id);
