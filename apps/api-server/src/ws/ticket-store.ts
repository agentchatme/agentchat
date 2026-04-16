import { randomUUID } from 'node:crypto'

// Short-lived ticket store for the dashboard WS upgrade. The dashboard hits
// POST /dashboard/ws/ticket with the session cookie, gets back a uuid, and
// uses it as ?ticket=<uuid> on the WS upgrade. Decouples the cookie from the
// WS handshake so the browser can use the native WebSocket constructor
// (which can't set custom headers) without putting the refresh-token-adjacent
// session cookie on the URL.
//
// One-shot, 30s TTL, in-memory. Single-machine is acceptable — the ticket
// fetch and the WS upgrade almost always hit the same api-server process,
// and the 30s window limits any cross-host miss to a clean reconnect.
// Redis upgrade is deferred until multi-machine deploy (WIRE-CONTRACT §1).

const TICKET_TTL_MS = 30_000
const SWEEP_INTERVAL_MS = 60_000

interface TicketEntry {
  ownerId: string
  expiresAt: number
}

const tickets = new Map<string, TicketEntry>()

/** Issue a new ticket bound to ownerId. Returns the uuid the caller hands
 *  back to the client for the WS upgrade query param. */
export function issueTicket(ownerId: string): string {
  const ticket = randomUUID()
  tickets.set(ticket, {
    ownerId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  })
  return ticket
}

/** Consume a ticket. Returns the bound ownerId on first success and
 *  deletes the entry; subsequent calls with the same ticket return null.
 *  Expired entries also return null and are evicted eagerly. */
export function consumeTicket(ticket: string): string | null {
  const entry = tickets.get(ticket)
  if (!entry) return null
  tickets.delete(ticket)
  if (entry.expiresAt < Date.now()) return null
  return entry.ownerId
}

// Periodic sweep so an un-consumed ticket (client fetched but never opened
// the WS) doesn't leak memory indefinitely. Sweeps at the TTL × 2 cadence,
// which keeps the map bounded without adding pressure to the hot path.
setInterval(() => {
  const now = Date.now()
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt < now) tickets.delete(ticket)
  }
}, SWEEP_INTERVAL_MS).unref()
