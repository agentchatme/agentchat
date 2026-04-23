/**
 * ChannelDirectoryAdapter — handle-prefix lookup against `/v1/directory`.
 *
 * AgentChat's directory is phone-book-style: exact handle or prefix match
 * only. No name/role/bio search (that's MoltBook's job). We expose this to
 * OpenClaw's shared directory surfaces so agents can autocomplete peers
 * from the normal compose/search UIs — and so the `search` message action
 * and `agentchat_search_directory` tool both route through the same code.
 *
 * `listGroups` / `listGroupMembers` map through conversations + group
 * participants. `self` returns the configured agent's public profile.
 */

import type {
  ChannelDirectoryAdapter,
  ChannelDirectoryEntry,
  OpenClawConfig,
} from './openclaw-types.js'

import { readChannelSection, readAccountRaw } from '../channel-account.js'
import { parseChannelConfig } from '../config-schema.js'
import { getClient } from './sdk-client.js'

function resolveAccount(cfg: OpenClawConfig | undefined, accountId?: string | null) {
  const section = readChannelSection(cfg)
  const raw = readAccountRaw(section, accountId ?? 'default')
  if (!raw) return null
  try {
    return parseChannelConfig(raw)
  } catch {
    return null
  }
}

function profileToEntry(agent: {
  readonly handle: string
  readonly display_name?: string | null
  readonly description?: string | null
  readonly avatar_url?: string | null
}): ChannelDirectoryEntry {
  return {
    kind: 'user',
    id: agent.handle,
    handle: agent.handle,
    name: agent.display_name ?? agent.handle,
    ...(agent.avatar_url ? { avatarUrl: agent.avatar_url } : {}),
  }
}

export const agentchatDirectoryAdapter: ChannelDirectoryAdapter = {
  async self({ cfg, accountId }) {
    const config = resolveAccount(cfg, accountId)
    if (!config) return null
    const client = getClient({ accountId: accountId ?? 'default', config })
    try {
      const me = await client.getMe()
      return profileToEntry(me)
    } catch {
      return null
    }
  },

  async listPeers({ cfg, accountId, query, limit }) {
    const config = resolveAccount(cfg, accountId)
    if (!config) return []
    const q = (query ?? '').trim()
    if (q.length < 2) return []
    const client = getClient({ accountId: accountId ?? 'default', config })
    try {
      const result = await client.searchAgents(q, { limit: limit ?? 20 })
      return result.agents.map(profileToEntry)
    } catch {
      return []
    }
  },

  async listPeersLive(params) {
    return this.listPeers!(params)
  },

  async listGroups({ cfg, accountId, query, limit }) {
    const config = resolveAccount(cfg, accountId)
    if (!config) return []
    const client = getClient({ accountId: accountId ?? 'default', config })
    try {
      const convs = await client.listConversations()
      const q = (query ?? '').trim().toLowerCase()
      const groupRows = convs.filter((c) => c.type === 'group')
      const filtered = q
        ? groupRows.filter((c) => (c.group_name ?? '').toLowerCase().includes(q))
        : groupRows
      const cap = limit ?? 50
      return filtered.slice(0, cap).map((c) => ({
        kind: 'group' as const,
        id: c.id,
        name: c.group_name ?? 'Untitled group',
        ...(c.group_avatar_url ? { avatarUrl: c.group_avatar_url } : {}),
      }))
    } catch {
      return []
    }
  },

  async listGroupsLive(params) {
    return this.listGroups!(params)
  },

  async listGroupMembers({ cfg, accountId, groupId, limit }) {
    const config = resolveAccount(cfg, accountId)
    if (!config) return []
    const client = getClient({ accountId: accountId ?? 'default', config })
    try {
      const group = await client.getGroup(groupId)
      const cap = limit ?? 256
      return group.members.slice(0, cap).map((m) => ({
        kind: 'user' as const,
        id: m.handle,
        handle: m.handle,
        name: m.display_name ?? m.handle,
      }))
    } catch {
      return []
    }
  },
}
