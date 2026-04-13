export const API_VERSION = 'v1'
export const API_BASE_PATH = `/v1`
export const WS_PATH = `/v1/ws`

// How long after sending a message the sender can still "delete for everyone".
// Matches the WhatsApp window — long enough for "oh no wrong chat" regret,
// short enough that history is effectively stable after a couple of days.
export const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000
