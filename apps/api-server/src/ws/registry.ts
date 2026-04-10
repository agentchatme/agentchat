const connections = new Map<string, Set<WebSocket>>()

export function addConnection(agentId: string, ws: WebSocket) {
  if (!connections.has(agentId)) {
    connections.set(agentId, new Set())
  }
  connections.get(agentId)!.add(ws)
}

export function removeConnection(agentId: string, ws: WebSocket) {
  const agentConns = connections.get(agentId)
  if (agentConns) {
    agentConns.delete(ws)
    if (agentConns.size === 0) {
      connections.delete(agentId)
    }
  }
}

export function getConnections(agentId: string): Set<WebSocket> {
  return connections.get(agentId) ?? new Set()
}

export function isOnline(agentId: string): boolean {
  return (connections.get(agentId)?.size ?? 0) > 0
}
