import type { WsMessage } from '@agentchat/shared'
import { ConnectionError } from './errors.js'

export type MessageHandler = (message: WsMessage) => void
export type ErrorHandler = (error: Error) => void

export interface RealtimeOptions {
  apiKey: string
  baseUrl?: string
  reconnect?: boolean
  reconnectInterval?: number
  maxReconnectAttempts?: number
}

// Time to wait for `hello.ok` after sending the HELLO frame before we give
// up and reconnect. Must stay under the server-side HELLO_TIMEOUT_MS (5s).
const HELLO_ACK_TIMEOUT_MS = 4_000

export class RealtimeClient {
  private ws: WebSocket | null = null
  private options: Required<RealtimeOptions>
  private handlers = new Map<string, Set<MessageHandler>>()
  private errorHandlers = new Set<ErrorHandler>()
  private reconnectAttempts = 0
  private helloAckTimer: ReturnType<typeof setTimeout> | null = null
  private authenticated = false

  constructor(options: RealtimeOptions) {
    this.options = {
      baseUrl: 'wss://api.agentchat.me',
      reconnect: true,
      reconnectInterval: 3000,
      maxReconnectAttempts: 10,
      ...options,
    }
  }

  connect(): void {
    // Authenticate via HELLO frame (not URL). Browser WebSocket cannot set
    // custom headers, so this is the only cross-runtime path. The API key
    // never appears in the URL, access logs, or Referer headers.
    const url = `${this.options.baseUrl}/v1/ws`
    this.ws = new WebSocket(url)
    this.authenticated = false

    this.ws.onopen = () => {
      // Send the HELLO frame as the very first message.
      try {
        this.ws!.send(JSON.stringify({ type: 'hello', api_key: this.options.apiKey }))
      } catch (err) {
        this.emitError(err instanceof Error ? err : new ConnectionError('HELLO send failed'))
        return
      }

      // Start a timer — if the server hasn't ACKed by then, the key is
      // either wrong or the server is sick; bail and let the reconnect
      // loop try again.
      this.helloAckTimer = setTimeout(() => {
        this.emitError(new ConnectionError('HELLO ack timeout'))
        try { this.ws?.close(1008, 'HELLO ack timeout') } catch { /* already closed */ }
      }, HELLO_ACK_TIMEOUT_MS)
    }

    this.ws.onmessage = (event) => {
      let message: WsMessage
      try {
        message = JSON.parse(String(event.data)) as WsMessage
      } catch {
        return
      }

      // Intercept the handshake ACK — never surfaces to user handlers.
      if (!this.authenticated) {
        if ((message as { type?: string }).type === 'hello.ok') {
          this.authenticated = true
          this.reconnectAttempts = 0
          if (this.helloAckTimer) {
            clearTimeout(this.helloAckTimer)
            this.helloAckTimer = null
          }
        }
        // Any other frame before hello.ok is ignored (shouldn't happen).
        return
      }

      const handlers = this.handlers.get(message.type)
      if (handlers) {
        for (const handler of handlers) {
          handler(message)
        }
      }
    }

    this.ws.onerror = () => {
      this.emitError(new ConnectionError('WebSocket error'))
    }

    this.ws.onclose = () => {
      if (this.helloAckTimer) {
        clearTimeout(this.helloAckTimer)
        this.helloAckTimer = null
      }
      this.authenticated = false

      if (this.options.reconnect && this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this.reconnectAttempts++
        setTimeout(() => this.connect(), this.options.reconnectInterval)
      }
    }
  }

  on(event: string, handler: MessageHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.add(handler)
  }

  send(message: WsMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new ConnectionError('WebSocket is not connected')
    }
    this.ws.send(JSON.stringify(message))
  }

  disconnect(): void {
    this.options.reconnect = false
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.authenticated = false
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error)
    }
  }
}
