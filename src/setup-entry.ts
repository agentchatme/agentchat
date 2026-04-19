/**
 * Setup-entry barrel.
 *
 * OpenClaw loads this file via `package.json`'s `openclaw.setupEntry` field
 * and reads `default` to obtain the setup-entry descriptor (plugin wrapper).
 * Kept separate from `index.ts` so discovery paths that only need setup
 * metadata don't drag in the full channel runtime.
 */

export {
  agentchatSetupEntry as default,
  agentchatSetupEntry,
  agentchatSetupPlugin,
} from './channel.setup.js'
