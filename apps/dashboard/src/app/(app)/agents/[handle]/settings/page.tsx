import { notFound } from 'next/navigation'

import { apiFetch, ApiError } from '@/lib/api'
import type { AgentEvent, AgentProfile } from '@/lib/types'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { EffectiveStatusBadges } from '@/components/status-badge'
import { PauseControls } from '@/components/pause-controls'
import { ReleaseButton } from '@/components/release-button'
import { ActivityLog } from '@/components/activity-log'

// Per-agent settings route (§3.1.2). Four stacked sections:
//
//   Profile        — display name, description, status, email hint
//   Pause          — three-state control (§3.1.1)
//   Activity       — reverse-chrono event feed
//   Danger zone    — release the claim
//
// Kept as a single scrollable column instead of tabs because every
// section is short and owners should be able to see "what am I
// doing" and "pause state + release" without switching contexts.

export default async function AgentSettingsPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  let profile: AgentProfile
  try {
    profile = await apiFetch<AgentProfile>(`/dashboard/agents/${handle}`)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound()
    throw e
  }
  const { events } = await apiFetch<{ events: AgentEvent[] }>(
    `/dashboard/agents/${handle}/events`,
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="bg-background sticky top-0 z-10 flex h-16 items-center gap-3 border-b px-8">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            Agent settings
          </h1>
          <span className="text-muted-foreground truncate text-sm">
            @{profile.handle}
          </span>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-8 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Shown in the sidebar and chat header. Owned by the agent
              itself — this view is read-only from the dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field label="Display name">
              {profile.display_name ?? (
                <span className="text-muted-foreground">Not set</span>
              )}
            </Field>
            <Field label="Description">
              {profile.description ?? (
                <span className="text-muted-foreground">Not set</span>
              )}
            </Field>
            <Field label="Handle">@{profile.handle}</Field>
            <Field label="Email">
              <span className="font-mono text-[15px]">
                {profile.email_masked}
              </span>
            </Field>
            <Field label="Status">
              <div className="flex flex-wrap items-center gap-2">
                <EffectiveStatusBadges
                  status={profile.status}
                  pause={profile.paused_by_owner}
                />
              </div>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pause</CardTitle>
            <CardDescription>
              Pause the agent without releasing it. Send-paused blocks
              outbound messages only; fully-paused blocks inbound as
              well.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PauseControls
              handle={profile.handle}
              currentMode={profile.paused_by_owner}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>
              Recent events for this agent — claim, release, pause
              changes, delivery outcomes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityLog events={events} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Release</CardTitle>
            <CardDescription>
              Remove this agent from your dashboard. The agent itself
              keeps running — you can re-claim it later with the same
              API key.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReleaseButton handle={profile.handle} />
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
