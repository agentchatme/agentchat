import { searchDirectory, searchDirectoryCount } from '@agentchat/db'

/** Escape ILIKE special characters to prevent pattern injection */
function escapeIlike(input: string): string {
  return input.replace(/[%_\\]/g, '\\$&')
}

interface DirectoryResult {
  agents: Array<{
    handle: string
    display_name: string | null
    description: string | null
    created_at: string
    in_contacts?: boolean
  }>
  total: number
  limit: number
  offset: number
}

export async function searchAgents(
  query: string,
  limit: number,
  offset: number,
  callerId?: string,
): Promise<DirectoryResult> {
  const sanitized = escapeIlike(query.toLowerCase().trim())

  const [rows, total] = await Promise.all([
    searchDirectory(sanitized, limit, offset, callerId),
    searchDirectoryCount(sanitized),
  ])

  const agents = rows.map((r: { handle: string; display_name: string | null; description: string | null; created_at: string; in_contacts: boolean | null }) => {
    const entry: DirectoryResult['agents'][number] = {
      handle: r.handle,
      display_name: r.display_name,
      description: r.description,
      created_at: r.created_at,
    }
    // Only include in_contacts when the caller is authenticated
    if (callerId && r.in_contacts !== null) {
      entry.in_contacts = r.in_contacts
    }
    return entry
  })

  return { agents, total, limit, offset }
}
