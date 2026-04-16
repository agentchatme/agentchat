'use client'

import { useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'

// Owns the single dashboard WebSocket for the lifetime of the (app)
// layout. Its only visible job: call router.refresh() when the
// api-server pushes a message.new event, so the RSC tree re-runs and
// the conversation list / active thread update live. See
// WIRE-CONTRACT.md for the full protocol.
//
// Not a context provider — it renders children unchanged. Keeping it
// side-effect-only avoids an extra Context hop for a surface no child
// currently needs to read connection state from.
//
// Auth: ticket fetch on mount (and after each close) uses same-origin
// /dashboard/ws/ticket via the next.config.ts rewrite. On 401 we mark
// the provider dormant — the existing silent-refresh middleware will
// fix the session on the user's next RSC navigation, and the
// visibilitychange handler reconnects on the next tab focus.

const TICKET_PATH = '/dashboard/ws/ticket'
const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const VISIBILITY_GRACE_MS = 10_000
// Periodic refresh that ensures the Next.js middleware runs and rotates
// the access token before it expires. The middleware's 15-minute refresh
// window starts at the 45-minute mark — this fires at 40 minutes so
// the next RSC request lands squarely inside that window.
const SESSION_KEEPALIVE_MS = 40 * 60 * 1_000

interface TicketResponse {
  ticket: string
  expires_in: number
}

interface HelloOkFrame {
  type: 'hello.ok'
  owner_id: string
}

interface MessageNewFrame {
  type: 'message.new'
  // payload shape matches DashboardMessage; not consumed directly —
  // we just trigger an RSC refresh and let the existing fetch path
  // re-hydrate through get_agent_messages_for_owner.
}

type InboundFrame = HelloOkFrame | MessageNewFrame | { type: string }

export function DashboardWsProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  // Stable ref so the mount-once effect can always call the current
  // router without depending on its identity (which changes after
  // every router.refresh(), and would re-run the effect → close WS →
  // reconnect → refresh → infinite loop).
  const routerRef = useRef(router)
  routerRef.current = router

  const wsRef = useRef<WebSocket | null>(null)
  const backoffRef = useRef<number>(BACKOFF_INITIAL_MS)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dormantRef = useRef<boolean>(false)
  const unmountedRef = useRef<boolean>(false)
  const helloReceivedRef = useRef<boolean>(false)
  const isInitialConnectRef = useRef<boolean>(true)

  useEffect(() => {
    const wsBase = process.env.NEXT_PUBLIC_WS_URL
    if (!wsBase) {
      // No endpoint configured — skip silently so local/unit builds
      // without the env var don't crash.
      return
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const clearVisibilityTimer = () => {
      if (visibilityTimerRef.current !== null) {
        clearTimeout(visibilityTimerRef.current)
        visibilityTimerRef.current = null
      }
    }

    const scheduleReconnect = () => {
      if (unmountedRef.current || dormantRef.current) return
      clearReconnectTimer()
      const delay = backoffRef.current
      backoffRef.current = Math.min(delay * 2, BACKOFF_MAX_MS)
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        void connect()
      }, delay)
    }

    const connect = async (): Promise<void> => {
      if (unmountedRef.current || dormantRef.current) return
      if (wsRef.current) return

      let ticket: string
      try {
        const res = await fetch(TICKET_PATH, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
        })
        if (res.status === 401) {
          // Session dead — let middleware re-auth on the next nav.
          // We wake up again on the next visibilitychange → visible.
          dormantRef.current = true
          return
        }
        if (!res.ok) {
          scheduleReconnect()
          return
        }
        const body = (await res.json()) as TicketResponse
        ticket = body.ticket
      } catch {
        // Network error. Back off and retry.
        scheduleReconnect()
        return
      }

      if (unmountedRef.current || dormantRef.current) return

      const url = `${wsBase}/v1/ws/dashboard?ticket=${encodeURIComponent(ticket)}`
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        scheduleReconnect()
        return
      }
      wsRef.current = ws
      helloReceivedRef.current = false

      ws.onmessage = (event) => {
        let frame: InboundFrame
        try {
          frame = JSON.parse(event.data as string) as InboundFrame
        } catch {
          // Drop malformed frames silently.
          return
        }

        if (frame.type === 'hello.ok') {
          helloReceivedRef.current = true
          backoffRef.current = BACKOFF_INITIAL_MS
          // On reconnect, refresh to catch missed messages. Skip the
          // very first connect — the page is already fresh from the
          // initial navigation and a redundant refresh would blink.
          if (!isInitialConnectRef.current) {
            startTransition(() => { routerRef.current.refresh() })
          }
          isInitialConnectRef.current = false
          return
        }

        if (!helloReceivedRef.current) return

        if (frame.type === 'message.new') {
          startTransition(() => { routerRef.current.refresh() })
          return
        }

        // Forward-compat: unknown event types are ignored.
      }

      ws.onclose = () => {
        wsRef.current = null
        helloReceivedRef.current = false
        if (unmountedRef.current || dormantRef.current) return
        scheduleReconnect()
      }

      ws.onerror = () => {
        // Always followed by a close event — let onclose handle the
        // retry so we don't schedule twice.
      }
    }

    const closeSocket = () => {
      helloReceivedRef.current = false
      const ws = wsRef.current
      if (!ws) return
      wsRef.current = null
      // Drop handlers before close() so the pending onclose doesn't
      // schedule a reconnect for a socket we're intentionally killing.
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        // Already closing — ignore.
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Grace timer absorbs fast alt-tab flips without churning
        // tickets and TCP sockets on every focus change.
        clearVisibilityTimer()
        visibilityTimerRef.current = setTimeout(() => {
          visibilityTimerRef.current = null
          clearReconnectTimer()
          closeSocket()
        }, VISIBILITY_GRACE_MS)
        return
      }

      // visible
      clearVisibilityTimer()
      if (dormantRef.current) {
        // Left dormant by a prior 401 — the user likely just re-authed
        // via a navigation, so a fresh ticket fetch should now succeed.
        dormantRef.current = false
      }
      if (!wsRef.current && !reconnectTimerRef.current) {
        backoffRef.current = BACKOFF_INITIAL_MS
        void connect()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    void connect()

    const keepalive = setInterval(() => {
      if (!unmountedRef.current && !dormantRef.current) {
        startTransition(() => { routerRef.current.refresh() })
      }
    }, SESSION_KEEPALIVE_MS)

    return () => {
      unmountedRef.current = true
      clearInterval(keepalive)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearReconnectTimer()
      clearVisibilityTimer()
      closeSocket()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once;
  // router is accessed via routerRef to avoid re-running on identity change
  }, [])

  return <>{children}</>
}
