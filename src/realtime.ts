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

export class RealtimeClient {
  private ws: WebSocket | null = null
  private options: Required<RealtimeOptions>
  private handlers = new Map<string, Set<MessageHandler>>()
  private errorHandlers = new Set<ErrorHandler>()
  private reconnectAttempts = 0

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
    const url = `${this.options.baseUrl}/v1/ws?token=${this.options.apiKey}`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
    }

    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as WsMessage
      const handlers = this.handlers.get(message.type)
      if (handlers) {
        for (const handler of handlers) {
          handler(message)
        }
      }
    }

    this.ws.onerror = () => {
      const error = new ConnectionError('WebSocket error')
      for (const handler of this.errorHandlers) {
        handler(error)
      }
    }

    this.ws.onclose = () => {
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionError('WebSocket is not connected')
    }
    this.ws.send(JSON.stringify(message))
  }

  disconnect(): void {
    this.options.reconnect = false
    this.ws?.close()
    this.ws = null
  }
}
