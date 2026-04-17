import { describe, it, expect, beforeEach, vi } from 'vitest'

// Covers the terminal-state routing added by migration 032: when a webhook
// delivery exhausts its retry budget, scheduleNextAttempt must move the
// row into `webhook_deliveries_dlq` via moveWebhookToDlq() instead of
// setting a 'dead' status in place. The DLQ table gives us a separate
// retention surface, a replay path, and a clean rolling-window count for
// the dlq-probe.
//
// The tests here pin the contract the worker owes:
//   - attempts < MAX → retry scheduled, DLQ untouched
//   - attempts >= MAX → moved to DLQ, no retry scheduled
//   - worker logs a structured warning on every DLQ move (operator grep)

const moveWebhookToDlqMock = vi.fn()
const scheduleWebhookRetryMock = vi.fn()
const loggerWarnMock = vi.fn()
const webhookDeliveriesInc = vi.fn()

vi.mock('@agentchat/db', () => ({
  moveWebhookToDlq: moveWebhookToDlqMock,
  scheduleWebhookRetry: scheduleWebhookRetryMock,
  // Unused by scheduleNextAttempt but imported at module top-level.
  claimWebhookDeliveries: vi.fn(),
  markWebhookDelivered: vi.fn(),
  updateDeliveryStatus: vi.fn(),
}))

vi.mock('../src/lib/metrics.js', () => ({
  webhookDeliveries: { inc: webhookDeliveriesInc },
}))

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../src/services/webhook-circuit-breaker.js', () => ({
  getOpenWebhookIds: vi.fn().mockResolvedValue([]),
  recordWebhookFailure: vi.fn(),
  recordWebhookSuccess: vi.fn(),
}))

const { _scheduleNextAttemptForTests, _MAX_ATTEMPTS_FOR_TESTS } = await import(
  '../src/services/webhook-worker.js'
)

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'whd_abc',
    webhook_id: 'whk_1',
    agent_id: 'agt_bob',
    url: 'https://example.com/hook',
    secret: 's3cr3t',
    event: 'message.new',
    payload: { event: 'message.new', data: { id: 'msg_1' } },
    status: 'delivering',
    attempts: 1,
    next_attempt_at: new Date().toISOString(),
    last_attempted_at: new Date().toISOString(),
    last_error: null,
    created_at: new Date().toISOString(),
    delivered_at: null,
    ...overrides,
  }
}

describe('scheduleNextAttempt → DLQ routing (migration 032)', () => {
  beforeEach(() => {
    moveWebhookToDlqMock.mockReset().mockResolvedValue(undefined)
    scheduleWebhookRetryMock.mockReset().mockResolvedValue(undefined)
    loggerWarnMock.mockReset()
    webhookDeliveriesInc.mockReset()
  })

  it('attempts < MAX → scheduleWebhookRetry, no DLQ transition', async () => {
    const row = makeRow({ attempts: 3 })
    await _scheduleNextAttemptForTests(
      row as Parameters<typeof _scheduleNextAttemptForTests>[0],
      'HTTP 500 internal',
    )
    expect(scheduleWebhookRetryMock).toHaveBeenCalledTimes(1)
    expect(moveWebhookToDlqMock).not.toHaveBeenCalled()
    expect(webhookDeliveriesInc).toHaveBeenCalledWith({ outcome: 'failed' })
  })

  it('attempts === MAX → moved to DLQ, no retry scheduled', async () => {
    const row = makeRow({ attempts: _MAX_ATTEMPTS_FOR_TESTS })
    await _scheduleNextAttemptForTests(
      row as Parameters<typeof _scheduleNextAttemptForTests>[0],
      'HTTP 500 internal',
    )
    expect(moveWebhookToDlqMock).toHaveBeenCalledTimes(1)
    expect(moveWebhookToDlqMock).toHaveBeenCalledWith('whd_abc', 'HTTP 500 internal')
    expect(scheduleWebhookRetryMock).not.toHaveBeenCalled()
    expect(webhookDeliveriesInc).toHaveBeenCalledWith({ outcome: 'dead' })
  })

  it('logs a structured warn with delivery context on every DLQ move', async () => {
    // Ops greps on `webhook_delivery_moved_to_dlq` — the log event name is
    // the contract. Pin it so a careless refactor doesn't silently rename
    // the line and break grafana/loki dashboards that key on it.
    const row = makeRow({ attempts: _MAX_ATTEMPTS_FOR_TESTS })
    await _scheduleNextAttemptForTests(
      row as Parameters<typeof _scheduleNextAttemptForTests>[0],
      'HTTP 500 internal',
    )
    expect(loggerWarnMock).toHaveBeenCalledTimes(1)
    const [fields, msg] = loggerWarnMock.mock.calls[0]!
    expect(msg).toBe('webhook_delivery_moved_to_dlq')
    expect(fields).toMatchObject({
      delivery_id: 'whd_abc',
      webhook_id: 'whk_1',
      agent_id: 'agt_bob',
      attempts: _MAX_ATTEMPTS_FOR_TESTS,
    })
  })

  it('DLQ transition is fire-and-continue — a DB error logs but does not throw', async () => {
    // scheduleNextAttempt is called from a Promise.allSettled batch in the
    // tick loop; if a single row's DLQ transition explodes, we want to log
    // and let the next tick re-observe the row in 'delivering' state (the
    // 60s stale-reclaim in claim_webhook_deliveries catches it).
    moveWebhookToDlqMock.mockRejectedValueOnce(new Error('conn reset'))
    const row = makeRow({ attempts: _MAX_ATTEMPTS_FOR_TESTS })
    await expect(
      _scheduleNextAttemptForTests(
        row as Parameters<typeof _scheduleNextAttemptForTests>[0],
        'HTTP 502',
      ),
    ).resolves.toBeUndefined()
  })

  it('attempts > MAX (edge — claim returned a stale already-exhausted row) still routes to DLQ', async () => {
    // Defensive: if a reclaim picks up a row whose attempts got bumped
    // beyond MAX by some concurrent path, we do NOT want to retry it. The
    // >= comparison in the worker is deliberate; this test pins it so a
    // careless edit to `===` would fail here.
    const row = makeRow({ attempts: _MAX_ATTEMPTS_FOR_TESTS + 5 })
    await _scheduleNextAttemptForTests(
      row as Parameters<typeof _scheduleNextAttemptForTests>[0],
      'boom',
    )
    expect(moveWebhookToDlqMock).toHaveBeenCalledTimes(1)
    expect(scheduleWebhookRetryMock).not.toHaveBeenCalled()
  })
})
