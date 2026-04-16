import { randomUUID } from 'node:crypto'
import { getRedis } from '../lib/redis.js'

// Short-lived ticket store for the dashboard WS upgrade. The dashboard hits
// POST /dashboard/ws/ticket with the session cookie, gets back a uuid, and
// uses it as ?ticket=<uuid> on the WS upgrade. Decouples the cookie from the
// WS handshake so the browser can use the native WebSocket constructor
// (which can't set custom headers) without putting the refresh-token-adjacent
// session cookie on the URL.
//
// One-shot, 30s TTL, backed by Upstash Redis. Multi-machine safe — the ticket
// fetch (POST /dashboard/ws/ticket) and the WS upgrade (GET /v1/ws/dashboard)
// can land on different api-server instances behind the load balancer, so
// in-process state would silently drop tickets the moment we run more than
// one machine. GETDEL gives us atomic one-shot semantics; Redis TTL handles
// expiry server-side, no local clock.

const TICKET_TTL_SECONDS = 30
const KEY_PREFIX = 'wsticket:'

/** Issue a new ticket bound to ownerId. Returns the uuid the caller hands
 *  back to the client for the WS upgrade query param. */
export async function issueTicket(ownerId: string): Promise<string> {
  const ticket = randomUUID()
  await getRedis().set(`${KEY_PREFIX}${ticket}`, ownerId, { ex: TICKET_TTL_SECONDS })
  return ticket
}

/** Consume a ticket. Returns the bound ownerId on first success and
 *  deletes the entry; subsequent calls with the same ticket return null.
 *  Expired entries return null because Redis has already evicted them. */
export async function consumeTicket(ticket: string): Promise<string | null> {
  if (!ticket) return null
  const ownerId = await getRedis().getdel<string>(`${KEY_PREFIX}${ticket}`)
  return typeof ownerId === 'string' ? ownerId : null
}
