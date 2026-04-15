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
import { SignOutEverywhereButton } from '@/components/sign-out-everywhere-button'

// Owner account settings (§3.1.2). Profile fields are read-only in
// Phase D1 — display name is set on first OTP verify and email is the
// identity, so there's nothing to edit yet. The Security card hosts
// sign-out-everywhere, the one cross-device auth action an owner can
// take before a mutate endpoint for the profile itself lands.

export default async function AccountPage() {
  const owner = await apiFetch<Owner>('/dashboard/me')

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="bg-background sticky top-0 z-10 flex h-16 items-center gap-3 border-b px-8">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            Account settings
          </h1>
          <span className="text-muted-foreground truncate text-sm">
            {owner.email}
          </span>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-8 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Your dashboard identity. Email is the handle used for
              OTP sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field label="Email">
              <span className="font-mono text-[15px]">{owner.email}</span>
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

        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>
              Sign out of every browser signed in as this account. Use
              if you think someone else may have accessed your account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SignOutEverywhereButton />
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
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
        {label}
      </span>
      <div className="text-[15px]">{children}</div>
      <Separator className="mt-2 last:hidden" />
    </div>
  )
}
