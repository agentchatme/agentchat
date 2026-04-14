import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

// ─── Server-side API fetch helper ──────────────────────────────────────────
// Used by RSC pages to call the dashboard API while forwarding the signed-in
// owner's session cookie. Client components use the Next rewrite proxy
// directly (fetch('/dashboard/...')) because their cookies are attached
// automatically by the browser.
//
// On 401, the helper throws a Next.js redirect to /login. This is the single
// place auth redirection is enforced — every RSC page that calls apiFetch
// gets the redirect behavior for free. Do NOT try/catch the thrown value in
// the page — let it propagate to Next's router.
//
// Every response is explicitly cache: 'no-store' because the dashboard is
// always showing live state. Page-level caching with stale data would leak
// across owner sessions via Next's fetch memoization.

const API_BASE = process.env['API_BASE'] ?? 'http://localhost:3000'

export class ApiError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

async function forwardedCookieHeader(): Promise<string> {
  const store = await cookies()
  return store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const cookieHeader = await forwardedCookieHeader()
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      cookie: cookieHeader,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  })

  if (res.status === 401) {
    // Not signed in (or session expired). Kick to /login — Next will
    // interrupt rendering and navigate. Callers don't need to handle
    // the thrown value.
    redirect('/login')
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string
      message?: string
    }
    throw new ApiError(
      body.code ?? 'INTERNAL_ERROR',
      body.message ?? `API request failed with ${res.status}`,
      res.status,
    )
  }

  return res.json() as Promise<T>
}

// Convenience: return null on 401 instead of redirecting. Used on pages
// that want to show a "not signed in" screen (e.g. the home page) rather
// than forcing a redirect loop.
export async function apiFetchOptional<T>(
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  const cookieHeader = await forwardedCookieHeader()
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      cookie: cookieHeader,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  })

  if (res.status === 401) return null
  if (!res.ok) return null
  return res.json() as Promise<T>
}
