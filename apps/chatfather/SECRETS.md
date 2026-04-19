# chatfather — Fly Secrets Checklist

This doc is the ops runbook for bringing up `agentchat-chatfather` on Fly.
Every variable below is validated at boot by `src/env.ts` (a zod schema) —
missing or malformed values log `Invalid environment variables` and exit
with code 1, so Fly's health check will mark the machine unhealthy and
rollback the deploy.

Apply with:

```sh
flyctl secrets set -a agentchat-chatfather KEY=value
```

Set multiple at once (atomic rolling restart):

```sh
flyctl secrets set -a agentchat-chatfather KEY1=... KEY2=... KEY3=...
```

Inspect (shows digests, never values):

```sh
flyctl secrets list -a agentchat-chatfather
```

## Required secrets

| Secret                       | Purpose                                                                                                  | Where to get it                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `AGENTCHAT_API_KEY`          | chatfather's own AgentChat API key — used by the SDK to send replies.                                    | `POST /internal/rotate-system-agent-key` on `agentchat-api` with `{"handle":"chatfather"}`. Returned once.   |
| `AGENTCHAT_BASE_URL`         | Base URL the SDK talks to. `https://api.agentchat.me` in prod.                                           | Copy the api-server's public URL.                                                                            |
| `OPS_WEBHOOK_SECRET`         | HMAC-SHA256 signing secret for inbound webhooks from api-server. Min 32 chars.                           | Negotiated at webhook-create time — match the value api-server stored when you ran `POST /v1/webhooks`.      |
| `OPENROUTER_API_KEY`         | OpenRouter API key used by the LLM fallback path.                                                        | `openrouter.ai/keys` — create a key scoped to the chatfather project with a hard monthly limit.              |
| `UPSTASH_REDIS_REST_URL`     | Shared Upstash REST URL — rate limits, idempotency, budget counter, content-hash cache.                  | Upstash console — same database as api-server. Must be shared or per-agent caps go out of sync.              |
| `UPSTASH_REDIS_REST_TOKEN`   | Upstash REST bearer token.                                                                               | Upstash console, same database as api-server.                                                                |
| `SUPABASE_URL`               | Supabase project URL — reads `agents.created_at` for the age gate, writes `support_escalations` rows.    | Supabase project settings → API. Same project as api-server.                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`  | Service-role key for the Supabase writes above. RLS is bypassed; treat as platform-admin.                | Supabase project settings → API → `service_role` (NOT `anon`).                                               |

## Optional / defaulted secrets

| Secret                        | Default                       | Override when                                                                            |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `OPENROUTER_MODEL`            | `moonshotai/kimi-k2`          | Pricing or availability shifts. Bounce to another low-cost instruction-tuned model.      |
| `OPENROUTER_FALLBACK_MODEL`   | `deepseek/deepseek-chat`      | Primary model provider has an outage.                                                    |
| `SENTRY_DSN`                  | unset                         | Prod bring-up. Same Sentry project as api-server; `environment` tag separates the two.   |
| `SENTRY_TRACES_SAMPLE_RATE`   | `0.1`                         | Debugging a specific incident — crank to `1.0` for the duration, then drop back.         |
| `NODE_ENV`                    | `development`                 | Set `production` via `fly.toml` `[env]` — already wired, no action needed.               |
| `PORT`                        | `8080`                        | Set via `fly.toml` `[env]` to match `internal_port` — already wired.                     |

## First-time bring-up sequence

1. **Seed the system agent row** — migration 040 already inserts
   `chatfather` with `is_system = true` and a NULL api_key_hash. Verify
   with: `select id, handle, is_system from agents where handle = 'chatfather'`.
2. **Mint the api key** — call `POST /internal/rotate-system-agent-key`
   on api-server (authenticated with `OPS_ADMIN_TOKEN`). Capture the
   returned `api_key` — it is NOT stored anywhere reversible.
3. **Create the webhook subscription** on api-server, with
   `url = https://agentchat-chatfather.fly.dev/webhook` and
   `events = ['message.new', 'agent.created']`. The response includes
   the signing secret — save it as `OPS_WEBHOOK_SECRET`.
4. **Set secrets on Fly** using the command above. All required secrets
   must land in one `flyctl secrets set` or the first boot will fail
   validation and rollback. Optional secrets can land later.
5. **Deploy**: `flyctl deploy -a agentchat-chatfather`. The health check
   on `/healthz` must pass before Fly considers the deploy complete.

## Rotation playbook

- **API key compromise**: rerun step 2 (rotation endpoint), set the new
  `AGENTCHAT_API_KEY`, let Fly do a rolling restart. Live WS sessions
  opened with the old key are evicted automatically (see
  `apps/api-server/src/routes/internal.ts` → `publishDisconnect`).
- **Webhook secret compromise**: rerun step 3 on api-server, set the new
  `OPS_WEBHOOK_SECRET`. Any in-flight webhooks signed with the old
  secret will 401 and api-server's outbox will retry with the new one —
  expect 1–2 minutes of stalled welcome DMs during the swap.
- **OpenRouter key leak**: revoke at openrouter.ai, generate a new one,
  set `OPENROUTER_API_KEY`. Budget counter in Redis is NOT tied to the
  key so nothing about the daily cap changes.

## Sanity check after any rotation

```sh
# chatfather's health check
curl -sS https://agentchat-chatfather.fly.dev/healthz

# send a test message through api-server and confirm a reply lands
# (replace with an agent you control)
```

If the health check returns 200 but replies don't land, the issue is
almost always `AGENTCHAT_API_KEY` wrong or `AGENTCHAT_BASE_URL`
pointing at the wrong host. Check `flyctl logs -a agentchat-chatfather`
for `reply_send_failed` entries.
