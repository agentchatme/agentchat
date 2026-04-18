import { describe, it, expect } from 'vitest'
import { verifyWebhook, WebhookVerificationError } from '../src/webhook-verify.js'

const secret = 'whsec_test_1234'

async function sign(message: string): Promise<string> {
  const subtle = globalThis.crypto.subtle
  const enc = new TextEncoder()
  const key = await subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await subtle.sign('HMAC', key, enc.encode(message))
  const bytes = new Uint8Array(sig)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

describe('verifyWebhook', () => {
  it('verifies a Stripe-style `t=…,v1=…` header', async () => {
    const body = JSON.stringify({
      event: 'message.new',
      timestamp: '2026-01-01T00:00:00Z',
      data: { hello: 'world' },
    })
    const ts = Math.floor(Date.now() / 1000)
    const digest = await sign(`${ts}.${body}`)
    const payload = await verifyWebhook({
      payload: body,
      signature: `t=${ts},v1=${digest}`,
      secret,
    })
    expect(payload.event).toBe('message.new')
  })

  it('rejects a forged signature', async () => {
    const body = '{"event":"message.new","timestamp":"2026-01-01T00:00:00Z","data":{}}'
    const ts = Math.floor(Date.now() / 1000)
    await expect(
      verifyWebhook({
        payload: body,
        signature: `t=${ts},v1=${'0'.repeat(64)}`,
        secret,
      }),
    ).rejects.toMatchObject({ reason: 'bad_signature' })
  })

  it('rejects stale timestamps beyond tolerance', async () => {
    const body = '{"event":"message.new","timestamp":"2025-01-01T00:00:00Z","data":{}}'
    const ts = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
    const digest = await sign(`${ts}.${body}`)
    await expect(
      verifyWebhook({
        payload: body,
        signature: `t=${ts},v1=${digest}`,
        secret,
        toleranceSeconds: 300,
      }),
    ).rejects.toMatchObject({ reason: 'timestamp_skew' })
  })

  it('accepts stale timestamps when tolerance is 0', async () => {
    const body = '{"event":"message.new","timestamp":"2025-01-01T00:00:00Z","data":{}}'
    const ts = Math.floor(Date.now() / 1000) - 3600
    const digest = await sign(`${ts}.${body}`)
    const res = await verifyWebhook({
      payload: body,
      signature: `t=${ts},v1=${digest}`,
      secret,
      toleranceSeconds: 0,
    })
    expect(res.event).toBe('message.new')
  })

  it('rejects missing signatures', async () => {
    await expect(
      verifyWebhook({
        payload: '{}',
        signature: null,
        secret,
      }),
    ).rejects.toMatchObject({ reason: 'missing_signature' })
  })

  it('rejects malformed signature headers', async () => {
    await expect(
      verifyWebhook({
        payload: '{}',
        signature: 't=1,v1=not-hex-just-words',
        secret,
      }),
    ).rejects.toMatchObject({ reason: 'malformed_signature' })
  })

  it('accepts bare hex signatures (no timestamp)', async () => {
    const body = '{"event":"message.new","timestamp":"2025-01-01T00:00:00Z","data":{}}'
    const digest = await sign(body)
    const res = await verifyWebhook({
      payload: body,
      signature: digest,
      secret,
    })
    expect(res.event).toBe('message.new')
  })

  it('rejects malformed JSON bodies even when the signature is valid', async () => {
    const body = 'not-json'
    const ts = Math.floor(Date.now() / 1000)
    const digest = await sign(`${ts}.${body}`)
    await expect(
      verifyWebhook({
        payload: body,
        signature: `t=${ts},v1=${digest}`,
        secret,
      }),
    ).rejects.toMatchObject({ reason: 'malformed_payload' })
  })

  it('accepts Uint8Array bodies', async () => {
    const body = '{"event":"message.new","timestamp":"2025-01-01T00:00:00Z","data":{}}'
    const bytes = new TextEncoder().encode(body)
    const ts = Math.floor(Date.now() / 1000)
    const digest = await sign(`${ts}.${body}`)
    const res = await verifyWebhook({
      payload: bytes,
      signature: `t=${ts},v1=${digest}`,
      secret,
    })
    expect(res.event).toBe('message.new')
  })

  it('surfaces the correct reason via a public error class', async () => {
    try {
      await verifyWebhook({ payload: '{}', signature: null, secret })
      expect.fail()
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookVerificationError)
      expect((err as WebhookVerificationError).reason).toBe('missing_signature')
    }
  })
})
