/**
 * ChannelResolverAdapter — handle/conversation-id → canonical target.
 *
 * Called by OpenClaw after `messaging.normalizeTarget` when it needs to
 * confirm an input actually exists on the network (e.g. before issuing a
 * send, to render "couldn't find @alice" rather than firing a 404). For
 * user kinds this hits `/v1/agents/:handle`; for group kinds it hits
 * `/v1/groups/:id`. Both gracefully degrade to `resolved: false` on any
 * error — the caller surfaces the miss to the agent.
 */

import type {
  ChannelResolverAdapter,
  ChannelResolveResult,
  OpenClawConfig,
} from './openclaw-types.js'

import { readChannelSection, readAccountRaw } from '../channel-account.js'
import { parseChannelConfig } from '../config-schema.js'
import { classifyConversationId } from '../inbound.js'
import { getClient } from './sdk-client.js'
import { normalizeAgentchatTarget } from './messaging.js'

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

export const agentchatResolverAdapter: ChannelResolverAdapter = {
  async resolveTargets({ cfg, accountId, inputs, kind }) {
    const config = resolveAccount(cfg, accountId)
    const unresolved: ChannelResolveResult[] = inputs.map((input) => ({
      input,
      resolved: false,
    }))
    if (!config) return unresolved
    const client = getClient({ accountId: accountId ?? 'default', config })

    const results: ChannelResolveResult[] = await Promise.all(
      inputs.map(async (input): Promise<ChannelResolveResult> => {
        const normalized = normalizeAgentchatTarget(input)
        if (!normalized) return { input, resolved: false }

        if (kind === 'group') {
          const looksLikeConv = classifyConversationId(normalized) === 'group'
          if (!looksLikeConv) return { input, resolved: false, note: 'group id required' }
          try {
            const group = await client.getGroup(normalized)
            return {
              input,
              resolved: true,
              id: group.id,
              name: group.name ?? 'Untitled group',
            }
          } catch {
            return { input, resolved: false, note: 'group not found' }
          }
        }

        // kind === 'user' — hit /v1/agents/:handle. Bare handle path.
        try {
          const agent = await client.getAgent(normalized)
          return {
            input,
            resolved: true,
            id: agent.handle,
            name: agent.display_name ?? agent.handle,
          }
        } catch {
          return { input, resolved: false, note: 'agent not found' }
        }
      }),
    )
    return results
  },
}
