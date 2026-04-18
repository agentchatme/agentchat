export type PresenceStatus = 'online' | 'offline' | 'busy'

export interface Presence {
  handle: string
  status: PresenceStatus
  custom_message: string | null
  last_seen: string | null
}

export interface PresenceUpdate {
  status: PresenceStatus
  custom_message?: string
}

/** `POST /v1/presence/batch` — query up to 100 handles at once. */
export interface PresenceBatchRequest {
  handles: string[]
}

/** Wire shape pushed over WS on `presence.update` events. */
export interface PresenceBroadcast {
  handle: string
  status: PresenceStatus
  custom_message: string | null
}
