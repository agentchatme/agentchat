/**
 * Connection state machine for the AgentChat WebSocket.
 *
 * Pure functions only — no I/O, no timers. The runtime (P2) owns the socket
 * and drives transitions by emitting events.
 *
 * States:
 *   DISCONNECTED    — initial, and after a clean close
 *   CONNECTING      — TCP/TLS handshake + WS upgrade in flight
 *   AUTHENTICATING  — socket open, waiting for `hello.ok` from server
 *   READY           — authenticated, receiving + sending normally
 *   DEGRADED        — heartbeat missed or send buffer full; still connected but impaired
 *   DRAINING        — SIGTERM received; flush in-flight sends, then close
 *   CLOSED          — terminal after clean shutdown
 *   AUTH_FAIL       — terminal after 401/403; operator action required (rotate key)
 *
 * Invariants:
 *   - From AUTH_FAIL, no event can move us back to CONNECTING without
 *     an explicit RECONFIGURED event (operator rotated key).
 *   - From CLOSED, only SHUTDOWN is a no-op; anything else is a bug.
 *   - DRAINING has a deadline (ms timestamp) after which we force-close.
 */

import type { UnixMillis } from './types.js'

export type ConnectionState =
  | { readonly kind: 'DISCONNECTED' }
  | { readonly kind: 'CONNECTING'; readonly attempt: number; readonly startedAt: UnixMillis }
  | { readonly kind: 'AUTHENTICATING'; readonly startedAt: UnixMillis }
  | { readonly kind: 'READY'; readonly connectedAt: UnixMillis }
  | { readonly kind: 'DEGRADED'; readonly since: UnixMillis; readonly reason: string }
  | { readonly kind: 'DRAINING'; readonly since: UnixMillis; readonly deadline: UnixMillis }
  | { readonly kind: 'CLOSED' }
  | { readonly kind: 'AUTH_FAIL'; readonly reason: string }

export type ConnectionEvent =
  | { readonly type: 'CONNECT'; readonly now: UnixMillis; readonly attempt: number }
  | { readonly type: 'SOCKET_OPEN'; readonly now: UnixMillis }
  | { readonly type: 'HELLO_OK'; readonly now: UnixMillis }
  | { readonly type: 'AUTH_REJECTED'; readonly reason: string }
  | { readonly type: 'SOCKET_CLOSED'; readonly code: number; readonly reason: string }
  | { readonly type: 'PING_TIMEOUT'; readonly now: UnixMillis }
  | { readonly type: 'BACKPRESSURE'; readonly now: UnixMillis; readonly reason: string }
  | { readonly type: 'RECOVERED'; readonly now: UnixMillis }
  | { readonly type: 'DRAIN_REQUESTED'; readonly now: UnixMillis; readonly deadline: UnixMillis }
  | { readonly type: 'DRAIN_COMPLETED' }
  | { readonly type: 'RECONFIGURED' }

/**
 * Apply an event to a state. Returns a new state.
 *
 * Illegal transitions (e.g. HELLO_OK while in DISCONNECTED) fall through to
 * the current state — the runtime should log them as `transition.invalid`
 * so they become visible in telemetry without crashing the process.
 */
export function transition(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (state.kind) {
    case 'DISCONNECTED': {
      if (event.type === 'CONNECT') {
        return { kind: 'CONNECTING', attempt: event.attempt, startedAt: event.now }
      }
      if (event.type === 'DRAIN_REQUESTED') return { kind: 'CLOSED' }
      // Reconnect hard-cap elevation — the runtime has given up on transport
      // retries and wants to force operator attention. Treat the same as a
      // genuine auth reject: terminal until RECONFIGURED.
      if (event.type === 'AUTH_REJECTED') return { kind: 'AUTH_FAIL', reason: event.reason }
      return state
    }

    case 'CONNECTING': {
      if (event.type === 'SOCKET_OPEN') return { kind: 'AUTHENTICATING', startedAt: event.now }
      if (event.type === 'SOCKET_CLOSED') return { kind: 'DISCONNECTED' }
      if (event.type === 'AUTH_REJECTED') return { kind: 'AUTH_FAIL', reason: event.reason }
      if (event.type === 'DRAIN_REQUESTED') return { kind: 'CLOSED' }
      return state
    }

    case 'AUTHENTICATING': {
      if (event.type === 'HELLO_OK') return { kind: 'READY', connectedAt: event.now }
      if (event.type === 'AUTH_REJECTED') return { kind: 'AUTH_FAIL', reason: event.reason }
      if (event.type === 'SOCKET_CLOSED') return { kind: 'DISCONNECTED' }
      if (event.type === 'DRAIN_REQUESTED') return { kind: 'CLOSED' }
      return state
    }

    case 'READY': {
      if (event.type === 'PING_TIMEOUT') {
        return { kind: 'DEGRADED', since: event.now, reason: 'ping-timeout' }
      }
      if (event.type === 'BACKPRESSURE') {
        return { kind: 'DEGRADED', since: event.now, reason: event.reason }
      }
      if (event.type === 'SOCKET_CLOSED') return { kind: 'DISCONNECTED' }
      if (event.type === 'AUTH_REJECTED') return { kind: 'AUTH_FAIL', reason: event.reason }
      if (event.type === 'DRAIN_REQUESTED') {
        return { kind: 'DRAINING', since: event.now, deadline: event.deadline }
      }
      return state
    }

    case 'DEGRADED': {
      if (event.type === 'RECOVERED') return { kind: 'READY', connectedAt: event.now }
      if (event.type === 'SOCKET_CLOSED') return { kind: 'DISCONNECTED' }
      if (event.type === 'AUTH_REJECTED') return { kind: 'AUTH_FAIL', reason: event.reason }
      if (event.type === 'DRAIN_REQUESTED') {
        return { kind: 'DRAINING', since: event.now, deadline: event.deadline }
      }
      return state
    }

    case 'DRAINING': {
      if (event.type === 'DRAIN_COMPLETED') return { kind: 'CLOSED' }
      if (event.type === 'SOCKET_CLOSED') return { kind: 'CLOSED' }
      return state
    }

    case 'AUTH_FAIL': {
      // Only an explicit reconfig (operator rotated key) can leave AUTH_FAIL.
      if (event.type === 'RECONFIGURED') return { kind: 'DISCONNECTED' }
      if (event.type === 'DRAIN_REQUESTED') return { kind: 'CLOSED' }
      return state
    }

    case 'CLOSED': {
      return state
    }
  }
}

/** True iff sends may be attempted in this state. */
export function canSend(state: ConnectionState): boolean {
  return state.kind === 'READY' || state.kind === 'DEGRADED' || state.kind === 'DRAINING'
}

/** True iff the state indicates a transport-level problem the runtime should recover from. */
export function shouldReconnect(state: ConnectionState): boolean {
  return state.kind === 'DISCONNECTED'
}

/** True iff the state is terminal and no further transitions are expected. */
export function isTerminal(state: ConnectionState): boolean {
  return state.kind === 'CLOSED' || state.kind === 'AUTH_FAIL'
}
