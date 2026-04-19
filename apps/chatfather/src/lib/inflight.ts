// ─── In-flight request tracker ─────────────────────────────────────────────
//
// Graceful-shutdown helper. On SIGTERM, chatfather needs to stop accepting
// new webhooks but let any webhook that's already past HMAC + idempotency
// finish processing — otherwise Fly kills the process mid-dispatch and
// api-server's outbox retries the delivery, which is usually fine but
// adds avoidable latency to user-visible replies during a rolling deploy.
//
// Contract:
//   - track(fn) increments an atomic counter for the duration of fn.
//   - waitForDrain(ms) resolves when the counter hits zero, or 'timeout'
//     if it doesn't within the budget.
//
// Intentionally not a general-purpose concurrency primitive: single
// module-level counter, single waiter. Chatfather has one caller
// (the webhook route) and one shutdown path, so this is enough.

let inFlight = 0
let drainResolver: (() => void) | null = null

export async function track<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
    if (inFlight === 0 && drainResolver) {
      drainResolver()
      drainResolver = null
    }
  }
}

export function getInFlight(): number {
  return inFlight
}

/**
 * Wait for in-flight requests to drain, or return 'timeout' after the
 * budget. If no requests are in flight, resolves immediately. Only one
 * waiter is supported — a second concurrent call will replace the first's
 * resolver, which is fine because we only ever call this once from
 * the SIGTERM handler.
 */
export function waitForDrain(timeoutMs: number): Promise<'drained' | 'timeout'> {
  if (inFlight === 0) return Promise.resolve('drained')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      drainResolver = null
      resolve('timeout')
    }, timeoutMs)
    drainResolver = () => {
      clearTimeout(timer)
      resolve('drained')
    }
  })
}
