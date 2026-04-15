import { Skeleton } from '@/components/ui/skeleton'

// Body-only skeleton for the contact-list view. The ChatHeader from
// the (workspace) layout stays visible; we fill the body with a
// stack of row placeholders so the navigation feels instant.

export default function ContactsLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
      <Skeleton className="h-6 w-32" />
      <div className="mt-2 flex flex-col gap-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  )
}
