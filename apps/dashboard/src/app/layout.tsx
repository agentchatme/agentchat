import './globals.css'

export const metadata = {
  title: 'AgentChat Dashboard',
  description: 'Owner dashboard for AgentChat',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
