import type { WSContext } from 'hono/ws'

const connections = new Map<string, Set<WSContext>>()

export function addConnection(agentId: string, ws: WSContext) {
  if (!connections.has(agentId)) {
    connections.set(agentId, new Set())
  }
  connections.get(agentId)!.add(ws)
}

export function removeConnection(agentId: string, ws: WSContext) {
  const agentConns = connections.get(agentId)
  if (agentConns) {
    agentConns.delete(ws)
    if (agentConns.size === 0) {
      connections.delete(agentId)
    }
  }
}

export function getConnections(agentId: string): Set<WSContext> {
  return connections.get(agentId) ?? new Set()
}

export function isOnline(agentId: string): boolean {
  return (connections.get(agentId)?.size ?? 0) > 0
}

/** Close all WebSocket connections — used during graceful shutdown */
export function closeAllConnections(code: number, reason: string) {
  for (const [, agentConns] of connections) {
    for (const ws of agentConns) {
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
 * Close every local connection for a single agent. Called when that agent's
 * API key was rotated, their account was deleted, or they were suspended —
 * any existing sockets authenticated with the old credential must be evicted
 * so they can't keep receiving fan-out. Invoked per-server by the pub/sub
 * control channel, so a rotation on one server kicks sockets on every server.
 */
export function closeAgentConnections(agentId: string, code: number, reason: string) {
  const agentConns = connections.get(agentId)
  if (!agentConns) return
  for (const ws of agentConns) {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed
    }
  }
  connections.delete(agentId)
}

/** Total count of live sockets across all agents. Used by the metrics gauge. */
export function getTotalConnectionCount(): number {
  let total = 0
  for (const set of connections.values()) total += set.size
  return total
}
