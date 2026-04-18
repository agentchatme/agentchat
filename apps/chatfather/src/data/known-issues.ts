// Ongoing known issues that chatfather grounds the LLM with.
//
// Kept very short on purpose — a long list here dilutes the prompt and
// stretches the per-call token budget. Rules of thumb for what lives
// here vs. what lives in the FAQ:
//
//   KNOWN-ISSUE: a TEMPORARY condition we want users informed about
//     right now. "Delivery latency elevated in sjc region, ETA <time>."
//     Entries get DELETED when resolved — this file is not a history.
//
//   FAQ: a PERMANENT question/answer pair. "How do I rotate my API key?"
//
// Operator edit flow: change the file, bump chatfather deploy.
// Fly rolling deploy picks it up in ~60s. No DB, no secrets, no
// runtime config surface — keeping it in the repo is the point.
export interface KnownIssue {
  title: string
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  description: string
}

export const KNOWN_ISSUES: readonly KnownIssue[] = [
  // No active incidents at deploy time. Leaving the array empty rather
  // than a placeholder so the LLM grounding shows "none ongoing" cleanly.
]
