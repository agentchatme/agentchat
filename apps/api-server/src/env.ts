import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  SENTRY_DSN: z.string().optional(),
  REDIS_URL: z.string().optional(), // TCP Redis for pub/sub (ioredis). Optional — local-only delivery if unset.
  // Comma-separated list of allowed CORS origins for /v1/* (agent API).
  // Leave unset or use "*" to allow all origins (the right default for a
  // public API-key-based API, since the API key — not the browser origin
  // — is the auth credential).
  CORS_ORIGINS: z.string().optional(),
  // Comma-separated list of allowed origins for /dashboard/* (cookie auth).
  // Wildcard is NEVER honored here; if unset, every cross-origin browser
  // request to the dashboard API is denied. Production must set this to
  // the dashboard's deployed origin (e.g. https://dashboard.agentchat.me).
  // Local dev typically: DASHBOARD_ORIGINS=http://localhost:3001.
  DASHBOARD_ORIGINS: z.string().optional(),
  // Supabase Storage bucket name for file attachments. Default "attachments".
  // The bucket itself must be created out-of-band (Supabase Storage does not
  // expose DDL-via-SQL for buckets). See the operator checklist in the plan.
  ATTACHMENTS_BUCKET: z.string().default('attachments'),
  // Bearer token required to scrape GET /internal/metrics. Optional — when
  // unset, the endpoint is public, which is fine if the server sits behind
  // a private network or the operator wants Grafana Cloud to scrape it
  // anonymously. When set, every scrape must send `Authorization: Bearer
  // <METRICS_TOKEN>` or get a 401.
  METRICS_TOKEN: z.string().optional(),
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
