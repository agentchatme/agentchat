import type { WSContext } from 'hono/ws'
import { safeSend } from './safe-send.js'

// Mirrors the agent registry (./registry.ts) but keyed on owner id for the
// dashboard WS fan-out. The two maps stay separate because owners and agents
// live in different id spaces and an owner's dashboard WS is read-only —
// conflating the two would mean every agent-push iteration had to skip owner
// sockets and vice versa.

const connections = new Map<string, Set<WSContext>>()

export function addOwnerConnection(ownerId: string, ws: WSContext) {
  if (!connections.has(ownerId)) {
    connections.set(ownerId, new Set())
  }
  connections.get(ownerId)!.add(ws)
}

export function removeOwnerConnection(ownerId: string, ws: WSContext) {
  const ownerConns = connections.get(ownerId)
  if (ownerConns) {
    ownerConns.delete(ws)
    if (ownerConns.size === 0) {
      connections.delete(ownerId)
    }
  }
}

export function getOwnerConnections(ownerId: string): Set<WSContext> {
  return connections.get(ownerId) ?? new Set()
}

/** Deliver one message to every local socket for an owner. Called by the
 *  pub/sub subscriber on each server to complete the multi-host fan-out. */
export function deliverLocallyToOwner(ownerId: string, message: unknown) {
  const ownerConns = connections.get(ownerId)
  if (!ownerConns || ownerConns.size === 0) return

  const raw = JSON.stringify(message)
  for (const ws of ownerConns) {
    // safeSend enforces the per-socket bufferedAmount ceiling — a paused
    // dashboard tab that's fallen behind gets closed with 1013 instead of
    // ballooning the api-server heap. The dashboard's reconnect refetches.
    safeSend(ws, raw)
  }
}

/** Iterate every open owner socket. Used by graceful shutdown to stop
 *  heartbeats without reaching into registry internals. */
export function getAllOwnerConnections(): Iterable<[string, Set<WSContext>]> {
  return connections.entries()
}

/** Close every local socket across every owner — used during graceful
 *  shutdown alongside closeAllConnections() on the agent registry. */
export function closeAllOwnerConnections(code: number, reason: string) {
  for (const [, ownerConns] of connections) {
    for (const ws of ownerConns) {
      try {
        ws.close(code, reason)
      } catch {
        // Already closed
      }
    }
  }
  connections.clear()
}

/**
 * Close every local connection for a single owner. Called when that owner
 * signed out of every device (POST /dashboard/auth/logout/all) so every
 * dashboard tab loses its WS on every host, not just the server that
 * handled the sign-out request. Invoked per-server by the pub/sub control
 * channel — mirrors closeAgentConnections on the agent side.
 */
export function closeOwnerConnections(ownerId: string, code: number, reason: string) {
  const ownerConns = connections.get(ownerId)
  if (!ownerConns) return
  for (const ws of ownerConns) {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed
    }
  }
  connections.delete(ownerId)
}

/** Total count of live owner sockets across all owners. */
export function getTotalOwnerConnectionCount(): number {
  let total = 0
  for (const set of connections.values()) total += set.size
  return total
}
