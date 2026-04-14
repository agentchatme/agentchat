import { redirect } from 'next/navigation'
import { apiFetchOptional } from '../lib/api'
import type { Owner } from '../lib/types'

// The landing page just decides "signed in or not" and sends the visitor
// to the right place. Not a page in its own right — /agents is the real
// landing page for authenticated owners.

export default async function Home() {
  const me = await apiFetchOptional<Owner>('/dashboard/me')
  if (me) {
    redirect('/agents')
  }
  redirect('/login')
}
