'use client'

import * as React from 'react'
import { ThemeProvider as NextThemesProvider } from 'next-themes'

// Thin wrapper around next-themes so the root layout stays free of
// 'use client'. Dark is the default; light is toggleable. We use the
// `class` attribute strategy (adds `.dark` to <html>) so the custom
// variant `@custom-variant dark (&:is(.dark *))` in globals.css picks
// it up. `disableTransitionOnChange` prevents a flash of transitions
// when the user swaps themes mid-session.
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
