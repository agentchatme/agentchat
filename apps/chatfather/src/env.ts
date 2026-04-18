import { z } from 'zod'

const envSchema = z.object({
  // ─── Runtime ────────────────────────────────────────────────────────
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // ─── AgentChat API (outbound — the SDK talks to this) ──────────────
  // The API key belongs to the chatfather agent row and is minted
  // exactly once via POST /internal/rotate-system-agent-key (migration
  // 040). Operator flow: run the rotation endpoint, take the returned
  // key, set it here via Fly secrets. Losing the key means rotating
  // again — no recovery path, by design.
  AGENTCHAT_API_KEY: z.string().min(1),
  // No default — `https://api.agentchat.me` in prod, `http://localhost:3000`
  // in dev. Forcing explicit wiring prevents the classic "works in dev,
  // talks to prod" class of bugs during early deploys.
  AGENTCHAT_BASE_URL: z.string().url(),

  // ─── Webhook ingest (inbound — api-server fires webhooks at us) ────
  // HMAC-SHA256 signing secret negotiated at webhook creation time. The
  // api-server signs every webhook with this; chatfather verifies with
  // constant-time compare before trusting any body. Leaking this lets
  // an attacker impersonate api-server to chatfather — roughly
  // equivalent to acting as chatfather for any agent. Treat as
  // high-sensitivity, rotate on any suspicion of compromise.
  OPS_WEBHOOK_SECRET: z.string().min(32),

  // ─── OpenRouter (LLM fallback for novel questions) ─────────────────
  // Chatfather routes common requests (/help, /report, greetings,
  // exact-keyword FAQ) through a zero-LLM fast-path. Only novel
  // questions fall through to OpenRouter. OpenRouter over direct
  // Anthropic/OpenAI so we can swap models in Fly secrets when
  // pricing or availability shifts without a redeploy.
  OPENROUTER_API_KEY: z.string().min(1),
  // Default: Kimi K2 — Moonshot's flagship at ~$0.15/M input, strong
  // instruction-following for a support-shaped workload. Fallback:
  // DeepSeek Chat (V3) at ~$0.27/M — picked for it on Kimi timeout/429.
  // Both are set low-cost on purpose: chatfather is not a reasoning
  // workhorse, it's a grounded answerer.
  OPENROUTER_MODEL: z.string().default('moonshotai/kimi-k2'),
  OPENROUTER_FALLBACK_MODEL: z.string().default('deepseek/deepseek-chat'),

  // ─── Redis (rate limits, idempotency, budget tracking) ─────────────
  // Upstash REST is the shared store for per-sender rate limits, daily
  // caps, webhook delivery idempotency (24h TTL SETNX), content-hash
  // collapse, and the fleet-wide LLM $-budget counter. Shared with
  // api-server so the per-agent cold-outreach cap is consistent
  // across the fleet, not per-machine.
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  // ─── Supabase (direct write to support_escalations) ────────────────
  // The escalation queue (migration 041) is read by human operators
  // through Supabase Studio, not via the public SDK. Chatfather writes
  // new rows with the service-role key. The table lives behind RLS
  // policies that deny the anon role entirely — only service-role can
  // insert. Do NOT proxy this key to the LLM or surface it in responses.
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
})

function loadEnv() {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors)
    process.exit(1)
  }
  return result.data
}

export const env = loadEnv()
