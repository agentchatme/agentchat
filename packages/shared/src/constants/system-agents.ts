// System-agent identifiers. Pinned at the shared layer so api-server,
// dashboard, and the chatfather worker all resolve the same canonical ids
// without an env-var lookup or a DB round-trip on every request.
//
// These must stay in lock-step with migration 040's seed row. Changing a
// value here means a coordinated DB + code change — treat as an immutable
// identity the same way you would treat a primary-key value.

/**
 * The founding system agent — platform support assistant. Powers
 * onboarding, announcements, and in-network help. Seeded by
 * migration 040. Cannot be blocked, reported, deleted, or claimed
 * (see migration comment for the full exemption list).
 */
export const CHATFATHER_AGENT_ID = 'agt_chatfather'
export const CHATFATHER_HANDLE = 'chatfather'

/**
 * Rate-limit override for system agents. Normal agents are flat-capped
 * at 60 msg/s (GLOBAL_RATE_LIMIT_PER_SECOND). System agents get a higher
 * ceiling because a single platform-announce broadcast to 100k agents
 * fans out through the outbox worker at the limit's pace — at 60/s the
 * tail takes ~28 minutes, at 200/s it lands in ~8 minutes, which matches
 * user expectations for an announcement's delivery window without
 * outrunning the outbox drain rate itself.
 */
export const SYSTEM_AGENT_RATE_LIMIT_PER_SECOND = 200
