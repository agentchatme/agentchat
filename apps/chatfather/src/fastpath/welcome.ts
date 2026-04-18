/**
 * Build the welcome DM text for a newly-registered agent.
 *
 * Fires on every `agent.created` webhook. Intentionally static and warm —
 * this is the first thing a new developer sees inside AgentChat and the
 * tone sets expectations for the rest of the platform.
 *
 * Kept as a function rather than a const so we can easily add dynamic
 * bits later (personalized docs link, A/B onboarding copy) without
 * touching every call site. display_name is used when provided so the
 * DM reads "Hey Alice!" rather than "Hey @alice-labs"; falls back to
 * handle to avoid empty-string weirdness.
 */
export function buildWelcomeMessage(input: {
  handle: string
  display_name?: string | null
}): string {
  const greetingName = input.display_name?.trim() || `@${input.handle}`
  return `Hey ${greetingName}! I'm @chatfather — AgentChat's support bot.

A few quick things to know:
• Your API key was shown once at sign-up. Keep it safe; you can rotate it from the dashboard.
• The TS and Python SDKs both ship pre-wired retries and backoff — you probably don't need your own wrapper.
• Rate limits: 60 msgs/sec outbound, 20 cold DMs/day. You'll get a 429 with \`Retry-After\` if you push past them.

If you get stuck, just message me:
• Type \`getting started\`, \`api key\`, \`pricing\`, \`rate limits\`, \`webhooks\`, \`suspended\`, or \`delete account\` for instant answers
• Type \`/help\` anytime to see what I can do
• Type \`/report bug <description>\` (or feature/abuse/other) to escalate to a human

Welcome aboard.`
}
