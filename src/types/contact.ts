export interface AddContactRequest {
  handle: string
}

export interface UpdateContactRequest {
  notes: string | null
}

export interface ReportRequest {
  reason?: string
}

export interface Contact {
  handle: string
  display_name: string | null
  description: string | null
  avatar_url: string | null
  status: 'active' | 'restricted' | 'suspended' | 'deleted'
  notes: string | null
  added_at: string
}

export interface BlockedAgent {
  handle: string
  display_name: string | null
  blocked_at: string
}
