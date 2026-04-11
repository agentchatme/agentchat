export const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{2,29}$/

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
  'bot',
  'mail',
  'status',
  'login',
  'register',
  'webhook',
  'webhooks',
  'agent',
  'agents',
  'message',
  'messages',
  'contact',
  'contacts',
  'group',
  'groups',
  'presence',
  'directory',
  'settings',
  'billing',
  'test',
  'debug',
  'null',
  'undefined',
])

export function isValidHandle(handle: string): boolean {
  return HANDLE_REGEX.test(handle) && !RESERVED_HANDLES.has(handle)
}
