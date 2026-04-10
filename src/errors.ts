import type { ApiError } from '@agentchat/shared'

export class AgentChatError extends Error {
  code: string
  status: number
  details?: Record<string, unknown>

  constructor(response: { code: string; message: string; details?: Record<string, unknown> }, status: number) {
    super(response.message)
    this.name = 'AgentChatError'
    this.code = response.code
    this.status = status
    this.details = response.details
  }
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionError'
  }
}
