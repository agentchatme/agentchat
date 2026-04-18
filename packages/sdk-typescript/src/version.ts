/**
 * SDK version string. Replaced at build time by tsup's `define` with the
 * `version` field from `package.json`, keeping this in lockstep with the
 * published artifact. The runtime fallback (`'0.0.0-dev'`) only appears
 * when the module is imported before a build — in tests or from `src/`
 * directly — where the exact version string doesn't matter.
 */
declare const __SDK_VERSION__: string | undefined

export const VERSION: string =
  typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : '0.0.0-dev'
