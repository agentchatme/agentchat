/**
 * Events pushed from server → client over the WebSocket. Group messages
 * reuse `message.new` — the `conversation_id` in the payload distinguishes
 * group from direct. There is no separate `group.message` event.
 */
export type ServerEvent =
  | 'message.new'
  | 'message.read'
  | 'presence.update'
  | 'typing.start'
  | 'typing.stop'
  | 'rate_limit.warning'
  | 'group.invite.received'
  | 'group.deleted'

/** Actions the client can push to the server over the WebSocket. */
export type ClientAction =
  | 'message.send'
  | 'message.read_ack'
  | 'presence.update'
  | 'typing.start'
  | 'typing.stop'

export interface WsMessage {
  type: ServerEvent | ClientAction
  payload: Record<string, unknown>
  id?: string
}
