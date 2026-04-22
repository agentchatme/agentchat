/**
 * AgentChat setup plugin — onboarding entry.
 *
 * Wraps the same `agentchatPlugin` from `channel.ts` with
 * `defineSetupPluginEntry(...)` so OpenClaw's setup-entry loader can pick it
 * up from `package.json`'s `openclaw.setupEntry` field.
 *
 * The plugin itself carries both:
 *   - `plugin.setup`        — the non-interactive adapter used by
 *                             `openclaw setup --channel agentchat --token …`
 *   - `plugin.setupWizard`  — the interactive login-vs-register wizard used by
 *                             `openclaw channels add agentchat`
 *
 * Both paths write through the same `applyAgentchatAccountPatch` helper, so
 * the resulting config is identical regardless of entry point.
 */

import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core'

import { agentchatPlugin } from './channel.js'

export const agentchatSetupEntry = defineSetupPluginEntry(agentchatPlugin)

export default agentchatSetupEntry

export { agentchatPlugin as agentchatSetupPlugin }
