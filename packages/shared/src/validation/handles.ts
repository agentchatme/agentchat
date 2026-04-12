export const HANDLE_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

// Reserved handles fall into four buckets:
//   1. Route conflicts — paths the API or future dashboard needs free
//   2. Authority impersonation — handles that imply trust/staff status
//   3. Reserved literals — null, undefined, true, etc.
//   4. Brand impersonation — top-tier AI/tech brands the platform must protect
//
// Be conservative — every entry is a handle a real user can't have. Add to
// this list when you ship a new top-level route or notice an obvious squat.
export const RESERVED_HANDLES = new Set([
  // ─── Route / path conflicts ────────────────────────────────────────────
  'v1', 'v2', 'v3', 'api', 'apis',
  'www', 'web', 'app', 'apps',
  'dashboard', 'console', 'panel',
  'register', 'login', 'logout', 'signin', 'signup', 'signout',
  'auth', 'oauth', 'sso',
  'verify', 'verification', 'recover', 'recovery', 'reset',
  'agent', 'agents',
  'message', 'messages',
  'conversation', 'conversations',
  'contact', 'contacts',
  'group', 'groups',
  'presence',
  'webhook', 'webhooks',
  'directory', 'search',
  'upload', 'uploads', 'download', 'downloads',
  'attachment', 'attachments',
  'metric', 'metrics',
  'openapi', 'swagger', 'docs', 'doc', 'documentation',
  'health', 'healthz', 'ping', 'ready', 'readyz', 'alive', 'liveness',
  'settings', 'config', 'configuration',
  'billing', 'payment', 'payments', 'pay', 'checkout', 'invoice', 'invoices',
  'subscribe', 'subscription', 'subscriptions',
  'account', 'accounts', 'profile', 'profiles', 'user', 'users', 'username',
  'me', 'self', 'you', 'i',
  'inbox', 'outbox', 'sent', 'drafts',
  'home', 'index',
  'page', 'pages',
  'static', 'assets', 'cdn', 'media', 'public', 'files', 'file',
  'image', 'images', 'photo', 'photos', 'video', 'videos',
  'mail', 'email',
  'notification', 'notifications', 'notify',
  'report', 'reports',
  'block', 'blocks',

  // ─── Authority / staff impersonation ───────────────────────────────────
  'admin', 'administrator', 'root', 'sudo', 'superuser',
  'mod', 'mods', 'moderator', 'moderators',
  'system', 'sysadmin', 'sys',
  'support', 'help', 'helpdesk', 'customerservice', 'customer',
  'official', 'verified', 'certified',
  'staff', 'team', 'employee',
  'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster',
  'legal', 'compliance', 'privacy', 'terms', 'tos', 'dpo',
  'press', 'media-team', 'pr',
  'about', 'contact-us', 'careers', 'jobs',
  'status',
  'bot', 'robot', 'ai',

  // ─── Platform self-references ──────────────────────────────────────────
  'agentchat', 'agentchatme', 'agent-chat',

  // ─── Reserved literals / common error sentinels ────────────────────────
  'null', 'undefined', 'nil', 'none', 'void',
  'true', 'false', 'nan',
  'default', 'unknown', 'anonymous', 'anon', 'guest',
  'everyone', 'all', 'nobody',
  'error', 'errors', '404', '500',
  'test', 'tests', 'testing', 'debug', 'qa',
  'dev', 'development', 'prod', 'production', 'staging',

  // ─── Brand impersonation (top-tier AI / chat platforms) ────────────────
  'anthropic', 'claude',
  'openai', 'chatgpt', 'gpt', 'gpt4', 'gpt-4', 'gpt5', 'gpt-5',
  'google', 'gemini', 'bard', 'deepmind',
  'microsoft', 'copilot', 'bing',
  'meta', 'llama', 'facebook', 'instagram', 'whatsapp',
  'apple', 'siri',
  'amazon', 'alexa', 'aws',
  'mistral', 'perplexity', 'cohere', 'huggingface',
  'xai', 'grok', 'twitter', 'x',
  'discord', 'slack', 'telegram', 'signal',
  'github', 'gitlab',
])

export function isValidHandle(handle: string): boolean {
  return handle.length >= 3 && handle.length <= 30 && HANDLE_REGEX.test(handle) && !RESERVED_HANDLES.has(handle)
}
