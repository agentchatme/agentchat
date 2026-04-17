/** Hard cap on active members per group.
 *
 *  The infrastructure-safe ceiling for this cap is determined by peak
 *  fan-out per group send, not by the member count itself: each send
 *  writes N-1 delivery rows, N-1 pub/sub publishes, and N-1 webhook
 *  enqueues. What bounds the WORST CASE is the per-group aggregate rate
 *  limit (GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND) — with it in place, peak
 *  fan-out per group is `agg_rate × (N-1)` regardless of how many senders
 *  are bursting. Per-recipient silent-drop math is effectively size-
 *  independent under that cap (~8–9 min to the 10k recipient backlog wall
 *  whether N=100 or N=256).
 *
 *  256 was picked as the first bump because it matches a proven peer
 *  benchmark (old WhatsApp / Messenger / Signal group ceiling), is
 *  comfortably within current fleet capacity with the aggregate rate
 *  limit in place, and leaves headroom to raise further (512 / 1024) once
 *  we've validated real workloads at this size. */
export const GROUP_MAX_MEMBERS = 256

/** Per-sender cap on group invites sent in a rolling 24h window. Flat,
 *  all agents. Belt-and-suspenders against "create 10,000 pending
 *  invites to flood invite-inboxes" — the pending-invite design already
 *  blocks auto-add, this caps the nuisance surface. 50/day is high
 *  enough that no legitimate user will hit it during normal use. */
export const GROUP_INVITES_PER_DAY = 50

export const GROUP_MAX_NAME_LENGTH = 100
export const GROUP_MAX_DESCRIPTION_LENGTH = 500
