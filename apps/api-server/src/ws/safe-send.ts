import type { WSContext } from 'hono/ws'
import type { WebSocket as NodeWebSocket } from 'ws'
import { wsBackpressureCloses } from '../lib/metrics.js'

// Per-socket send-buffer ceiling. The `ws` library queues outbound frames
// in memory when the TCP socket can't drain them — a slow consumer (cell
// network, paused background tab, plain malicious peer) can balloon the
// buffer until the api-server runs out of heap. At ~5KB/message this caps
// the queue at ~800 messages per offending client; once we hit it the
// client is too far behind to catch up via push and a sync-on-reconnect is
// strictly cheaper than continuing to accumulate.
//
// 1013 (Try Again Later) signals a transient overload; client SDKs treat
// it as a normal reconnect and resume via the standard sync drain path.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024 // 4 MiB

/**
 * Send raw text to a hono WSContext, respecting per-socket backpressure.
 * Returns true if the frame was queued, false if the socket was over the
 * buffer ceiling (and was closed) or already dead.
 *
 * Callers that need to know whether the message reached the wire (e.g.
 * for marking an envelope `delivered`) should treat false as "did not
 * deliver" and rely on the sync-on-reconnect path.
 */
export function safeSend(ws: WSContext, raw: string): boolean {
  // ws.raw is the underlying `ws.WebSocket`; bufferedAmount is the live
  // count of bytes queued for transmission. hono doesn't expose this on
  // its own WSContext, so we reach through.
  const native = ws.raw as NodeWebSocket | undefined
  const buffered = native?.bufferedAmount ?? 0

  if (buffered > MAX_BUFFERED_BYTES) {
    wsBackpressureCloses.inc({ side: 'agent_or_owner' })
    try {
      ws.close(1013, 'overload')
    } catch {
      // already closing — fine
    }
    return false
  }

  try {
    ws.send(raw)
    return true
  } catch {
    return false
  }
}
