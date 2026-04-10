export const HANDLE_REGEX = /^[a-z0-9][a-z0-9_-]{2,29}$/

export const RESERVED_HANDLES = new Set([
  'admin',
  'system',
  'agentchat',
  'support',
  'help',
  'api',
  'www',
  'app',
  'dashboard',
  'root',
  'mod',
  'moderator',
])

export function isValidHandle(handle: string): boolean {
  return HANDLE_REGEX.test(handle) && !RESERVED_HANDLES.has(handle)
}
