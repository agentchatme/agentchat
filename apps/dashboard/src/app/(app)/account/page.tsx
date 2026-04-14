import { format } from 'date-fns'

import { apiFetch } from '@/lib/api'
import type { Owner } from '@/lib/types'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

// Owner account settings (§3.1.2). The api-server doesn't yet expose
// a mutate endpoint for the owner's own profile — display name is
// set on first OTP verify and email is the identity, so there's
// nothing to edit here in Phase D1. The route exists so the sidebar
// link has a real destination and so the URL is stable when the
// mutate endpoint lands (follow-up: PATCH /dashboard/me).

export default async function AccountPage() {
  const owner = await apiFetch<Owner>('/dashboard/me')

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="bg-background sticky top-0 z-10 flex h-14 items-center gap-3 border-b px-6">
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="text-sm font-semibold">Account settings</h1>
          <span className="text-muted-foreground truncate text-xs">
            {owner.email}
          </span>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Your dashboard identity. Email is the handle used for
              OTP sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Email">
              <span className="font-mono text-xs">{owner.email}</span>
            </Field>
            <Field label="Display name">
              {owner.display_name ?? (
                <span className="text-muted-foreground">Not set</span>
              )}
            </Field>
            <Field label="Account created">
              {format(new Date(owner.created_at), 'PPP')}
            </Field>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </span>
      <div className="text-sm">{children}</div>
      <Separator className="mt-2 last:hidden" />
    </div>
  )
}
