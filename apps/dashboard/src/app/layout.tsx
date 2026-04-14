import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'

// Root layout is deliberately thin. Every post-auth screen mounts its
// own admin-panel shell (see src/app/(app)/layout.tsx), so here we only
// set up theme and toasts — both of which must straddle the auth /
// app boundary so toasts from a /login submit survive the redirect
// into /(app).
//
// suppressHydrationWarning on <html> is required by next-themes: it
// writes the initial theme class synchronously before hydration to
// avoid a flash, which otherwise triggers a mismatch warning.

export const metadata: Metadata = {
  title: 'AgentChat',
  description: 'Admin panel for AgentChat owners',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  )
}
