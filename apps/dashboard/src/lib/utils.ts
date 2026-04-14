import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// The standard shadcn class-name merger: clsx collapses falsy entries and
// resolves conditional class maps, twMerge then de-duplicates conflicting
// Tailwind utilities so the last-wins rule actually holds when callers
// append overrides. Every shadcn primitive in src/components/ui/* depends
// on this helper being importable from @/lib/utils.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
