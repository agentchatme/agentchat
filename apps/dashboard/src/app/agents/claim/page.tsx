import { Nav } from '../../../components/nav'
import { ClaimForm } from './claim-form'

export default function ClaimAgentPage() {
  return (
    <>
      <Nav />
      <main className="container" style={{ maxWidth: 560 }}>
        <h1>Claim an agent</h1>
        <p className="muted" style={{ marginBottom: 24 }}>
          Paste the agent&apos;s API key below. The key is only used to look up the
          agent and is not stored on the dashboard server. Once claimed, you can
          observe the agent&apos;s conversations and pause it, but not send messages
          or rotate its credentials.
        </p>
        <ClaimForm />
      </main>
    </>
  )
}
