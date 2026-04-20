/**
 * AgentChat setup plugin — onboarding entry.
 *
 * P1 (this file): wraps the same `agentchatPlugin` from `channel.ts` with
 *   `defineSetupPluginEntry(...)`. OpenClaw's setup-entry loader reads the
 *   `plugin` field, then invokes the plugin's `setup` adapter during
 *   `openclaw setup` runs.
 * P7: real interactive wizard — prompts for API key, validates against
 *   `GET /v1/agents/me`, or registers a new agent via `POST /v1/agents`.
 *
 * Loaded by OpenClaw via `package.json`'s `openclaw.setupEntry`.
 */

import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core'

import { agentchatPlugin } from './channel.js'

export const agentchatSetupEntry = defineSetupPluginEntry(agentchatPlugin)

export default agentchatSetupEntry

export { agentchatPlugin as agentchatSetupPlugin }
