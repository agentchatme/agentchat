export const HANDLE_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

// Reserved handles fall into six buckets:
//   1. Route conflicts — every literal path segment the API uses today or may
//      use soon. When you ship a new top-level route, add its segments here
//      in the same PR.
//   2. Authority impersonation — handles that imply trust/staff/operator status
//   3. Platform self-references — AgentChat itself and its sister products
//   4. Reserved literals — null, undefined, true, etc.
//   5. Brand impersonation — AI labs, agent frameworks, chat platforms, and
//      infrastructure partners whose names could confuse or mislead
//   6. Founder / org reserves — handles held for the founding team and parent
//      company so they can't be squatted before first use
//
// Be conservative — every entry is a handle a real user can't have. But an
// un-reserved route-segment is a handle squatting vector, so when in doubt,
// reserve it.
export const RESERVED_HANDLES = new Set([
  // ─── 1. Route / path conflicts ─────────────────────────────────────────
  // Top-level API prefixes
  'v1', 'v2', 'v3', 'api', 'apis',
  'www', 'web', 'app', 'apps',
  'dashboard', 'console', 'panel',

  // Auth flows
  'register', 'login', 'logout', 'signin', 'signup', 'signout',
  'auth', 'oauth', 'sso', 'otp',
  'verify', 'verification', 'recover', 'recovery', 'reset',
  'refresh', 'rotate-key',

  // Core resources
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

  // Sub-resource segments (literal path components in existing routes)
  'sync', 'ack',
  'invite', 'invites',
  'member', 'members',
  'participant', 'participants',
  'promote', 'demote', 'leave',
  'pause', 'unpause',
  'claim', 'release',
  'bootstrap', 'ticket',
  'request', 'callback',
  'read', 'deliver', 'hide',
  'ban', 'kick',

  // Health / ops
  'health', 'healthz', 'ping', 'ready', 'readyz', 'alive', 'liveness',
  'settings', 'config', 'configuration',

  // Billing (Phase 4)
  'billing', 'payment', 'payments', 'pay', 'checkout', 'invoice', 'invoices',
  'subscribe', 'subscription', 'subscriptions',

  // Account / identity
  'account', 'accounts', 'profile', 'profiles', 'user', 'users', 'username',
  'me', 'self', 'you', 'i',
  'owner', 'owners',

  // Messaging concepts
  'inbox', 'outbox', 'sent', 'drafts',
  'thread', 'threads',
  'feed', 'activity',
  'archive', 'archived',

  // Navigation / static
  'home', 'index',
  'page', 'pages',
  'static', 'assets', 'cdn', 'media', 'public', 'files', 'file',
  'image', 'images', 'photo', 'photos', 'video', 'videos',
  'mail', 'email',
  'notification', 'notifications', 'notify',
  'report', 'reports',
  'block', 'blocks',

  // Data portability / ops
  'export', 'import',
  'audit', 'log', 'logs',
  'event', 'events',
  'cron', 'job', 'jobs', 'worker', 'queue',
  'internal', 'badge', 'badges',

  // ─── 2. Authority / staff impersonation ────────────────────────────────
  'admin', 'administrator', 'root', 'sudo', 'superuser',
  'mod', 'mods', 'moderator', 'moderators',
  'system', 'sysadmin', 'sys',
  'support', 'help', 'helpdesk', 'customerservice', 'customer',
  'official', 'verified', 'certified',
  'staff', 'team', 'employee',
  'operator', 'ops',
  'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster',
  'noreply', 'no-reply', 'mailer-daemon',
  'info', 'service', 'services',
  'legal', 'compliance', 'privacy', 'terms', 'tos', 'dpo',
  'press', 'media-team', 'pr',
  'about', 'contact-us', 'careers', 'jobs',
  'trust', 'trust-safety', 'trust-and-safety',
  'status',
  'bot', 'robot', 'ai',

  // ─── 3. Platform self-references & sister products ─────────────────────
  'agentchat', 'agentchatme', 'agent-chat',
  'agentchat-api', 'agentchat-app', 'agentchat-dev',
  'agentmail', 'agent-mail',
  'moltbook', 'moltmatch',
  'openclaw', 'open-claw',
  'eviralabs', 'vibekeys',

  // ─── 4. Reserved literals / common error sentinels ─────────────────────
  'null', 'undefined', 'nil', 'none', 'void',
  'true', 'false', 'nan',
  'default', 'unknown', 'anonymous', 'anon', 'guest',
  'everyone', 'all', 'nobody',
  'error', 'errors', '404', '500',
  'test', 'tests', 'testing', 'debug', 'qa',
  'dev', 'development', 'prod', 'production', 'staging',

  // ─── 5. Brand impersonation ────────────────────────────────────────────
  // AI labs & model families
  'anthropic', 'claude',
  'openai', 'chatgpt', 'gpt', 'gpt4', 'gpt-4', 'gpt5', 'gpt-5', 'dall-e', 'dalle',
  'google', 'gemini', 'bard', 'deepmind',
  'microsoft', 'copilot', 'bing',
  'meta', 'llama', 'facebook', 'instagram', 'whatsapp',
  'apple', 'siri',
  'amazon', 'alexa', 'aws',
  'mistral', 'perplexity', 'cohere', 'huggingface',
  'xai', 'grok', 'twitter', 'x',
  'nvidia', 'deepseek', 'groq',
  'stability', 'midjourney',
  'ibm', 'watson',

  // Agent frameworks & developer tools (integration targets from §4.1/§5)
  'langchain', 'langgraph', 'crewai',
  'autogpt', 'auto-gpt', 'autogen',
  'replicate', 'cursor',

  // Chat / messaging platforms (directly competitive namespace)
  'discord', 'slack', 'telegram', 'signal',
  'wechat', 'snapchat', 'line',
  'reddit', 'linkedin',

  // Infrastructure partners (could confuse users into trusting a fake)
  'vercel', 'supabase', 'cloudflare', 'stripe',
  'github', 'gitlab',

  // Mega-corps with AI divisions (high impersonation value)
  'samsung', 'tencent', 'alibaba', 'baidu',
  'bytedance', 'tiktok',
  'databricks', 'snowflake', 'salesforce', 'oracle',

  // ─── 6. Founder / org reserves ─────────────────────────────────────────
  'chatfather',
  'san', 'saneo',
])

export function isValidHandle(handle: string): boolean {
  return handle.length >= 3 && handle.length <= 30 && HANDLE_REGEX.test(handle) && !RESERVED_HANDLES.has(handle)
}
