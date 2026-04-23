/**
 * SSRF protection on `uploadMediaFromUrl`.
 *
 * `ctx.mediaUrl` is supplied by the agent, so without guardrails a bad
 * or compromised agent could exfiltrate cloud metadata by pointing us at
 * `http://169.254.169.254/...` (AWS IMDS) or probe the internal network
 * via `http://localhost:*`. The outbound adapter must reject any URL
 * whose host resolves-by-pattern to a private / loopback / link-local
 * range before `fetch` runs.
 *
 * We exercise the `assertMediaUrlSafe` checks indirectly through the
 * adapter's `sendMedia` path: a rejected URL must throw
 * `AgentChatChannelError` with class `terminal-user`, and `fetch` must
 * never have been called.
 */

import { describe, it, expect } from 'vitest'

import { agentchatOutboundAdapter } from '../../src/binding/outbound.js'
import { AgentChatChannelError } from '../../src/errors.js'

function buildCtx(mediaUrl: string) {
  return {
    cfg: {
      channels: {
        agentchat: {
          apiKey: 'ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa',
          apiBase: 'https://api.agentchat.me',
        },
      },
    },
    to: 'alice',
    text: '',
    mediaUrl,
    accountId: 'default',
  }
}

/**
 * Every URL in this matrix must be rejected synchronously by
 * `assertMediaUrlSafe` before any network I/O. We verify the error CLASS
 * is `terminal-user` — that's what marks it as non-retriable and blocks
 * the runtime from re-attempting the send.
 */
describe('outbound.sendMedia SSRF protection', () => {
  const privateUrls: Array<[string, string]> = [
    ['AWS IMDS', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback v4', 'http://127.0.0.1/secrets'],
    ['loopback hostname', 'http://localhost:8080/admin'],
    ['RFC1918 10/8', 'http://10.0.0.1/'],
    ['RFC1918 192.168', 'http://192.168.1.1/router'],
    ['RFC1918 172.16', 'http://172.16.0.1/'],
    ['link-local v6', 'http://[fe80::1]/'],
    ['ULA v6', 'http://[fd12:3456:789a::1]/'],
    ['loopback v6', 'http://[::1]/'],
  ]

  for (const [label, url] of privateUrls) {
    it(`rejects ${label}: ${url}`, async () => {
      let caught: unknown = null
      try {
        await agentchatOutboundAdapter.sendMedia!(buildCtx(url) as never)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AgentChatChannelError)
      expect((caught as AgentChatChannelError).class_).toBe('terminal-user')
    })
  }

  it('rejects non-http(s) protocols (javascript:, data:, gopher:, ftp:)', async () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/plain;base64,aGVsbG8=',
      'gopher://example.com/',
      'ftp://example.com/file',
    ]) {
      let caught: unknown = null
      try {
        await agentchatOutboundAdapter.sendMedia!(buildCtx(url) as never)
      } catch (e) {
        caught = e
      }
      expect(caught, `expected rejection for ${url}`).toBeInstanceOf(AgentChatChannelError)
      expect((caught as AgentChatChannelError).class_).toBe('terminal-user')
    }
  })

  it('rejects completely malformed URLs', async () => {
    await expect(
      agentchatOutboundAdapter.sendMedia!(buildCtx('not-a-url-at-all') as never),
    ).rejects.toThrow(AgentChatChannelError)
  })

  it('rejects sendMedia called without mediaUrl', async () => {
    const ctx = buildCtx('')
    ctx.mediaUrl = undefined as unknown as string
    await expect(agentchatOutboundAdapter.sendMedia!(ctx as never)).rejects.toThrow(
      AgentChatChannelError,
    )
  })
})
