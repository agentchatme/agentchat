/** Hard cap on active members per group. Chosen for Phase 1 to keep
 *  per-message fan-out bounded: each send writes N-1 delivery envelope rows
 *  plus N-1 pub/sub publishes plus N-1 webhook enqueues. At 100 members
 *  that's ~100 rows + ~100 pushes per group send, well within Postgres
 *  and Redis throughput for Phase 1 scale. */
export const GROUP_MAX_MEMBERS = 100

/** Per-sender cap on group invites sent in a rolling 24h window. Flat,
 *  all agents. Belt-and-suspenders against "create 10,000 pending
 *  invites to flood invite-inboxes" — the pending-invite design already
 *  blocks auto-add, this caps the nuisance surface. 50/day is high
 *  enough that no legitimate user will hit it during normal use. */
export const GROUP_INVITES_PER_DAY = 50

export const GROUP_MAX_NAME_LENGTH = 100
export const GROUP_MAX_DESCRIPTION_LENGTH = 500
