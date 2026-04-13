import { createMiddleware } from 'hono/factory'
import { createHash } from 'node:crypto'
import { getRedis } from '../lib/redis.js'

// Stripe-style Idempotency-Key support. Applied after authMiddleware so
// every key is scoped to the calling agent — two clients using the same
// random string cannot collide, and a leaked key cannot be replayed by
// anyone else. Intended to cover the hard-non-idempotent mutation
// endpoints (block/report/read receipts/group CRUD/member mgmt/invite
// accept). POST /v1/messages already has its own client_msg_id unique
// constraint, so it does not need this layer.
//
// Semantics (match Stripe as closely as is sensible):
//
//   1. Client sends `Idempotency-Key: <8-128 chars of [A-Za-z0-9_-]>`.
//   2. Server hashes `METHOD \0 PATH \0 BODY` and stores it alongside
//      an in-progress marker under `idem:{agentId}:{key}`.
//   3. Handler runs. On non-5xx, we cache the (status, headers, body)
//      tuple for 24h. On 5xx (or if the body is too large to cache),
//      the in-progress marker is released so the client can retry.
//   4. A second request with the same key + same hash → replay the
//      cached response (skipping the handler, no side effects).
//   5. A second request with the same key but DIFFERENT hash → 422
//      IDEMPOTENCY_KEY_CONFLICT — the client reused a key with a
//      different body, which almost always means a bug.
//   6. A second request that arrives while the first is still running
//      → 409 IDEMPOTENT_IN_PROGRESS. The lock TTL (60s) caps how long
//      a crashed client has to wait before it can retry.
//
// Redis failures are fail-open: without a backing store the middleware
// degrades to pass-through, matching the rate-limit middleware's policy.
// Retry-safety is a nice-to-have that should not take the API down if
// Upstash has a bad minute.

type IdempotencyEnv = {
  Variables: {
    agentId: string
  }
}

// Sanity bounds on the header value. Upper bound keeps Redis keys small;
// lower bound rejects trivially-short strings like "1" that are almost
// certainly not UUIDs.
const KEY_REGEX = /^[A-Za-z0-9_-]{8,128}$/

// How long a completed response stays replayable. Matches Stripe's
// documented 24h window.
const COMPLETED_TTL_SECS = 24 * 60 * 60

// How long the in-progress marker is held. Longer than any real handler
// (p99 mutation latency is well under a second for us), short enough
// that a crashed client can retry quickly.
const IN_PROGRESS_TTL_SECS = 60

// Responses larger than this are not cached. Mutation endpoints should
// never return payloads this big; if they do, we silently fall back to
// non-idempotent behaviour for that key rather than bloating Redis.
const MAX_CACHED_BODY_BYTES = 64 * 1024

// Headers that must NOT be restored verbatim on replay — Node and the
// WHATWG Response constructor compute these from the body.
const SKIP_REPLAY_HEADERS = new Set(['content-length', 'transfer-encoding'])

interface StoredResponse {
  state: 'completed'
  bodyHash: string
  status: number
  headers: Record<string, string>
  body: string
}

interface InProgressMarker {
  state: 'in_progress'
  bodyHash: string
}

type CacheEntry = StoredResponse | InProgressMarker

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const idempotencyMiddleware = createMiddleware<IdempotencyEnv>(async (c, next): Promise<any> => {
  // Safe methods are naturally idempotent — nothing to protect.
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next()
  }

  const rawKey = c.req.header('Idempotency-Key')
  if (!rawKey) {
    // Opt-in: clients that want retry-safety send the header. Those
    // that don't get the old behaviour so upgrading the server doesn't
    // break existing SDK versions.
    return next()
  }

  if (!KEY_REGEX.test(rawKey)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_INVALID',
        message:
          'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-]. Use a UUID or random hex string.',
      },
      400,
    )
  }

  // Auth must have run first — we scope per agent so two unrelated
  // clients using the same random key never collide with each other.
  const agentId = c.get('agentId')
  if (!agentId) {
    // Mounted somewhere without auth in front of it. Best we can do is
    // pass through; the endpoint is either public (rare) or will 401
    // further down the chain anyway.
    return next()
  }

  // Read the raw request body via a clone, so Hono's c.req.json() /
  // c.req.text() downstream still has an unconsumed body stream.
  let bodyText = ''
  try {
    bodyText = await c.req.raw.clone().text()
  } catch {
    bodyText = ''
  }

  const bodyHash = createHash('sha256')
    .update(method)
    .update('\0')
    .update(c.req.path)
    .update('\0')
    .update(bodyText)
    .digest('hex')

  const redisKey = `idem:${agentId}:${rawKey}`
  const redis = getRedis()

  // Try to claim the key with an in-progress marker. SET NX EX is
  // atomic — either we get the slot or we see the existing entry.
  const inProgress: InProgressMarker = { state: 'in_progress', bodyHash }
  let claimed: 'OK' | null = null
  try {
    claimed = (await redis.set(redisKey, inProgress, {
      nx: true,
      ex: IN_PROGRESS_TTL_SECS,
    })) as 'OK' | null
  } catch {
    // Upstash unreachable — fail open, serve as if no key was sent.
    // Same policy as middleware/rate-limit.ts: idempotency is a
    // retry-safety optimization, not a correctness boundary.
    return next()
  }

  if (claimed !== 'OK') {
    // Key is already held by someone — look up what's there.
    let existing: CacheEntry | null = null
    try {
      existing = (await redis.get<CacheEntry>(redisKey)) ?? null
    } catch {
      return next()
    }

    if (!existing) {
      // Tiny race window: the key expired between SET NX returning null
      // and our GET. Try to claim again; if still unable, pass through.
      try {
        const retry = (await redis.set(redisKey, inProgress, {
          nx: true,
          ex: IN_PROGRESS_TTL_SECS,
        })) as 'OK' | null
        if (retry !== 'OK') {
          return next()
        }
        // Fall through to the "we have the lock" path below.
      } catch {
        return next()
      }
    } else if (existing.state === 'in_progress') {
      if (existing.bodyHash !== bodyHash) {
        return c.json(
          {
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message:
              'Idempotency-Key was reused with a different request body. Use a fresh key for a new request.',
          },
          422,
        )
      }
      return c.json(
        {
          code: 'IDEMPOTENT_IN_PROGRESS',
          message:
            'A request with the same Idempotency-Key is still in flight. Retry shortly.',
        },
        409,
      )
    } else {
      // Completed entry — replay if the body matches, reject otherwise.
      if (existing.bodyHash !== bodyHash) {
        return c.json(
          {
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message:
              'Idempotency-Key was reused with a different request body. Use a fresh key for a new request.',
          },
          422,
        )
      }

      const replayHeaders = new Headers(existing.headers)
      // Flag the replay so clients (and logs) can tell the handler did
      // NOT run again for this request.
      replayHeaders.set('Idempotent-Replay', 'true')
      return new Response(existing.body, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: existing.status as any,
        headers: replayHeaders,
      })
    }
  }

  // We own the slot — run the handler.
  await next()

  // Only cache success and client-error responses. 5xx are treated as
  // transient so a retry is allowed to reach the handler again.
  const status = c.res.status
  if (status >= 500) {
    try {
      await redis.del(redisKey)
    } catch {
      // Best-effort — the in-progress marker will TTL out in 60s.
    }
    return
  }

  let storedBody = ''
  try {
    storedBody = await c.res.clone().text()
  } catch {
    storedBody = ''
  }

  if (Buffer.byteLength(storedBody, 'utf8') > MAX_CACHED_BODY_BYTES) {
    try {
      await redis.del(redisKey)
    } catch {
      // Best-effort.
    }
    return
  }

  const headers: Record<string, string> = {}
  c.res.headers.forEach((value, key) => {
    if (!SKIP_REPLAY_HEADERS.has(key.toLowerCase())) {
      headers[key] = value
    }
  })

  const stored: StoredResponse = {
    state: 'completed',
    bodyHash,
    status,
    headers,
    body: storedBody,
  }

  try {
    await redis.set(redisKey, stored, { ex: COMPLETED_TTL_SECS })
  } catch {
    // Request already succeeded for the caller; we just miss future
    // replay — acceptable.
  }
})
