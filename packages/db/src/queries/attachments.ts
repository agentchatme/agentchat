import { getSupabaseClient } from '../client.js'

export interface AttachmentRow {
  id: string
  uploader_id: string
  // Direct target: set when the attachment is addressed to a single
  // recipient (1:1 conversation). NULL for group uploads.
  recipient_id: string | null
  // Group target: set when the attachment is addressed to a group
  // conversation. NULL for direct uploads. A DB-level CHECK constraint
  // (migration 018) guarantees exactly one of (recipient_id, conversation_id)
  // is set.
  conversation_id: string | null
  filename: string
  content_type: string
  size: number
  sha256: string
  storage_path: string
  created_at: string
}

export async function createAttachment(row: {
  id: string
  uploader_id: string
  recipient_id: string | null
  conversation_id: string | null
  filename: string
  content_type: string
  size: number
  sha256: string
  storage_path: string
}): Promise<AttachmentRow> {
  const { data, error } = await getSupabaseClient()
    .from('attachments')
    .insert(row)
    .select()
    .single()

  if (error) throw error
  return data as AttachmentRow
}

export async function getAttachmentById(id: string): Promise<AttachmentRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('attachments')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return (data as AttachmentRow) ?? null
}
