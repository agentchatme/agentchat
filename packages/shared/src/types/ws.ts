import { z } from 'zod'

// There is intentionally NO 'message.deleted' event. AgentChat only
// supports hide-for-me deletion (see project_agentchat_no_delete_for_everyone):
// a hide never changes the recipient's view of a message, so there's
// nothing to notify the other side about. Do not add it back.
export const ServerEvent = z.enum([
  'message.new',
  'message.read',
  'presence.update',
  'group.message',
  'typing.start',
  'typing.stop',
  'rate_limit.warning',
])
export type ServerEvent = z.infer<typeof ServerEvent>

export const ClientAction = z.enum([
  'message.send',
  'message.read_ack',
  'presence.update',
  'typing.start',
])
export type ClientAction = z.infer<typeof ClientAction>

export const WsMessage = z.object({
  type: z.union([ServerEvent, ClientAction]),
  payload: z.record(z.unknown()),
  id: z.string().optional(),
})
export type WsMessage = z.infer<typeof WsMessage>
