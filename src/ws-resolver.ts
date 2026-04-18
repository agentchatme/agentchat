/**
 * Runtime-dependent WebSocket resolution.
 *
 * - Node 22+, browsers, Deno, Bun, and every major edge runtime ship a
 *   native `WebSocket` on `globalThis`. We use it directly — no dependency.
 * - Node 20 does NOT have a native `WebSocket`. Consumers on Node 20
 *   who want the realtime feed must install the `ws` package (listed as
 *   an optional peer dep). We dynamic-import it at first use so Node 22+
 *   consumers never pay the require cost and the SDK remains tree-shakable.
 *
 * The resolved constructor is cached after the first successful call.
 */

type WebSocketCtor = typeof globalThis.WebSocket

let cached: WebSocketCtor | null = null

export async function resolveWebSocket(): Promise<WebSocketCtor> {
  if (cached) return cached

  const native = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (native) {
    cached = native
    return native
  }

  try {
    // Built as an ESM dynamic import. tsup preserves the expression so
    // bundlers / runtimes that can't resolve `ws` simply hit the catch
    // below and surface a friendly error to the caller.
    const mod = (await import('ws')) as unknown as {
      default?: WebSocketCtor
      WebSocket?: WebSocketCtor
    }
    const ctor = mod.default ?? mod.WebSocket
    if (!ctor) {
      throw new Error('The `ws` package loaded but did not export a WebSocket constructor.')
    }
    cached = ctor
    return ctor
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `AgentChat SDK: no WebSocket implementation available. ${reason}\n` +
        `Install the \`ws\` package if you're on Node 20 (Node 22+ has a native WebSocket).`,
    )
  }
}
