/**
 * ChannelMessageActionAdapter — wires OpenClaw's shared `message` tool
 * actions to AgentChat SDK calls.
 *
 * OpenClaw defines a fixed vocabulary of message-tool actions
 * (`CHANNEL_MESSAGE_ACTION_NAMES`). Each one we `supportsAction` for is
 * exposed on the `message` tool that the agent sees. When the agent picks
 * an action + target, OpenClaw calls our `handleAction` which runs the
 * AgentChat operation and returns a text result.
 *
 * Actions we implement (everything the AgentChat platform natively
 * supports; everything else is a no-op):
 *   - read / unsend / delete / reply  → message-level ops
 *   - renameGroup / setGroupIcon       → group metadata
 *   - addParticipant / removeParticipant / leaveGroup → group membership
 *   - set-presence / set-profile       → own-identity edits
 *   - search                           → directory prefix lookup
 *   - member-info                      → peer profile lookup
 *   - channel-list / channel-info      → conversation listings
 *   - download-file / upload-file      → attachment I/O
 *
 * Tool results use OpenClaw's `AgentToolResult` shape:
 *   { content: [{ type: "text", text: "..." }] }
 *
 * Errors surface as `AgentChatChannelError` classes so the shared
 * retry/backoff layer up-stack can decide whether to retry.
 */

import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from './openclaw-types.js'

import { readChannelSection, readAccountRaw } from '../channel-account.js'
import { parseChannelConfig } from '../config-schema.js'
import { getClient } from './sdk-client.js'

const SUPPORTED_ACTIONS: readonly ChannelMessageActionName[] = [
  'send',
  'reply',
  'read',
  'unsend',
  'delete',
  'renameGroup',
  'setGroupIcon',
  'addParticipant',
  'removeParticipant',
  'leaveGroup',
  'set-presence',
  'set-profile',
  'search',
  'member-info',
  'channel-list',
  'channel-info',
  'download-file',
  'upload-file',
]

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: null }
}

function err(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `error: ${message}` }],
    details: { error: message },
  }
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === 'string' ? v : undefined
}

function resolveConfig(ctx: ChannelMessageActionContext) {
  const section = readChannelSection(ctx.cfg)
  const raw = readAccountRaw(section, ctx.accountId ?? 'default')
  if (!raw) return null
  try {
    return parseChannelConfig(raw)
  } catch {
    return null
  }
}

export const agentchatActionsAdapter: ChannelMessageActionAdapter = {
  describeMessageTool(): ChannelMessageToolDiscovery {
    return {
      actions: SUPPORTED_ACTIONS,
      capabilities: null,
      schema: null,
    }
  },

  supportsAction({ action }) {
    return SUPPORTED_ACTIONS.includes(action)
  },

  resolveExecutionMode() {
    return 'local'
  },

  async handleAction(ctx) {
    const config = resolveConfig(ctx)
    if (!config) {
      return err('channels.agentchat configuration missing or invalid')
    }
    const client = getClient({ accountId: ctx.accountId ?? 'default', config })
    const p = ctx.params

    try {
      switch (ctx.action) {
        case 'read': {
          const messageId = str(p, 'messageId') ?? str(p, 'message_id')
          if (!messageId) return err('read: messageId is required')
          await client.markAsRead(messageId)
          return ok(`marked ${messageId} as read`)
        }

        case 'unsend':
        case 'delete': {
          const messageId = str(p, 'messageId') ?? str(p, 'message_id')
          if (!messageId) return err('unsend: messageId is required')
          await client.deleteMessage(messageId)
          return ok(
            `hidden ${messageId} for you. The other side still sees their copy — AgentChat messages are immutable by design.`,
          )
        }

        case 'renameGroup': {
          const groupId = str(p, 'groupId') ?? str(p, 'group_id')
          const name = str(p, 'name')
          if (!groupId || !name) return err('renameGroup: groupId and name are required')
          await client.updateGroup(groupId, { name })
          return ok(`renamed group to "${name}"`)
        }

        case 'setGroupIcon': {
          const groupId = str(p, 'groupId') ?? str(p, 'group_id')
          const avatarUrl = str(p, 'url') ?? str(p, 'avatarUrl')
          if (!groupId || !avatarUrl) return err('setGroupIcon: groupId and url are required')
          await client.updateGroup(groupId, { avatar_url: avatarUrl })
          return ok(`updated group avatar`)
        }

        case 'addParticipant': {
          const groupId = str(p, 'groupId') ?? str(p, 'group_id')
          const handle = str(p, 'handle') ?? str(p, 'participant')
          if (!groupId || !handle) return err('addParticipant: groupId and handle are required')
          const result = await client.addGroupMember(groupId, handle.replace(/^@/, ''))
          return ok(`addParticipant: @${handle} → ${result.outcome}`)
        }

        case 'removeParticipant': {
          const groupId = str(p, 'groupId') ?? str(p, 'group_id')
          const handle = str(p, 'handle') ?? str(p, 'participant')
          if (!groupId || !handle) return err('removeParticipant: groupId and handle are required')
          await client.removeGroupMember(groupId, handle.replace(/^@/, ''))
          return ok(`removed @${handle} from group`)
        }

        case 'leaveGroup': {
          const groupId = str(p, 'groupId') ?? str(p, 'group_id')
          if (!groupId) return err('leaveGroup: groupId is required')
          await client.leaveGroup(groupId)
          return ok(`left group`)
        }

        case 'set-presence': {
          const status = str(p, 'status')
          if (!status || !['online', 'offline', 'busy'].includes(status)) {
            return err('set-presence: status must be one of online | offline | busy')
          }
          const customMessage =
            str(p, 'customMessage') ??
            str(p, 'custom_message') ??
            str(p, 'customStatus') ??
            str(p, 'custom_status')
          const req: { status: 'online' | 'offline' | 'busy'; custom_message?: string } = {
            status: status as 'online' | 'offline' | 'busy',
          }
          if (customMessage !== undefined && customMessage.length > 0) {
            req.custom_message = customMessage
          }
          await client.updatePresence(req)
          return ok(
            customMessage
              ? `presence → ${status} (${customMessage})`
              : `presence → ${status}`,
          )
        }

        case 'set-profile': {
          const displayName = str(p, 'displayName') ?? str(p, 'display_name')
          const description = str(p, 'description')
          const handle = config.agentHandle
          if (!handle) return err('set-profile: agentHandle not in config — cannot self-edit')
          const patch: { display_name?: string; description?: string } = {}
          if (displayName !== undefined) patch.display_name = displayName
          if (description !== undefined) patch.description = description
          if (Object.keys(patch).length === 0) {
            return err('set-profile: supply at least one of displayName or description')
          }
          await client.updateAgent(handle, patch)
          return ok(`profile updated`)
        }

        case 'search': {
          const query = str(p, 'query') ?? str(p, 'q')
          if (!query) return err('search: query is required')
          const limit = typeof p.limit === 'number' ? p.limit : 20
          const result = await client.searchAgents(query, { limit })
          if (result.agents.length === 0) {
            return ok(`no agents found matching "${query}"`)
          }
          const lines = result.agents.map(
            (a) =>
              `@${a.handle}${a.display_name ? ` (${a.display_name})` : ''}${a.description ? ` — ${a.description}` : ''}`,
          )
          return ok(`found ${result.agents.length} of ${result.total}:\n${lines.join('\n')}`)
        }

        case 'member-info': {
          const handle = (str(p, 'handle') ?? str(p, 'member'))?.replace(/^@/, '')
          if (!handle) return err('member-info: handle is required')
          const agent = await client.getAgent(handle)
          const parts = [`@${agent.handle}`]
          if (agent.display_name) parts.push(`display: ${agent.display_name}`)
          if (agent.description) parts.push(`about: ${agent.description}`)
          parts.push(`status: ${agent.status}`)
          return ok(parts.join(' — '))
        }

        case 'channel-list': {
          const convs = await client.listConversations()
          if (convs.length === 0) return ok('no conversations yet')
          const lines = convs.map((c) => {
            if (c.type === 'group') {
              return `${c.id} — group "${c.group_name ?? 'Untitled'}" (${c.group_member_count ?? 0} members)`
            }
            const peer = c.participants[0]
            return `${c.id} — dm with @${peer?.handle ?? 'unknown'}${c.is_muted ? ' (muted)' : ''}`
          })
          return ok(lines.join('\n'))
        }

        case 'channel-info': {
          const conversationId = str(p, 'conversationId') ?? str(p, 'conversation_id')
          if (!conversationId) return err('channel-info: conversationId is required')
          const participants = await client.getConversationParticipants(conversationId)
          const lines = participants.map(
            (pp) => `@${pp.handle}${pp.display_name ? ` (${pp.display_name})` : ''}`,
          )
          return ok(`participants (${participants.length}):\n${lines.join('\n')}`)
        }

        case 'upload-file':
        case 'download-file':
          return err(
            `${ctx.action}: use sendMessage with an attachment_id instead — the outbound adapter handles upload automatically`,
          )

        default:
          return err(`action "${ctx.action}" is not supported by AgentChat`)
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  },
}
