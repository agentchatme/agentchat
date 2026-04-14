import { generateId } from '../lib/id.js'
import {
  addContact,
  removeContact,
  listContacts,
  checkContact,
  updateContactNotes,
  isBlocked,
  blockAgent,
  unblockAgent,
  hasReported,
  reportAgent,
  findAgentByHandle,
  getPausedByOwner,
} from '@agentchat/db'
import { fireWebhooks } from './webhook.service.js'
import { evaluateEnforcement } from './enforcement.service.js'

// ─── Push gating helper ────────────────────────────────────────────────────
// Skip non-message push events when the recipient is fully paused by their
// owner. Mirrors the same rule applied to message.new fan-out in
// message.service.ts (pushToRecipient / pushToGroup). Without this, contact
// blocked/report webhooks slip through the dashboard pause guard.
//
// Failure mode: if the pause lookup itself errors, we LOG and proceed as
// 'none' so a transient DB blip doesn't suppress legitimate events. The
// drainUndelivered handler in ws/handler.ts uses the same failover policy.
async function isFullyPaused(agentId: string): Promise<boolean> {
  try {
    return (await getPausedByOwner(agentId)) === 'full'
  } catch (err) {
    console.error('[contact.service] getPausedByOwner failed; assuming none:', agentId, err)
    return false
  }
}

export class ContactError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ContactError'
    this.code = code
    this.status = status
  }
}

async function resolveHandle(handle: string) {
  const agent = await findAgentByHandle(handle)
  if (!agent) {
    throw new ContactError('AGENT_NOT_FOUND', `Account @${handle} not found`, 404)
  }
  return agent
}

export async function addToContacts(agentId: string, targetHandle: string) {
  const target = await resolveHandle(targetHandle)

  if (target.id === agentId) {
    throw new ContactError('VALIDATION_ERROR', 'Cannot add yourself as a contact', 400)
  }

  await addContact(agentId, target.id)
  return { handle: target.handle, display_name: target.display_name }
}

export async function removeFromContacts(agentId: string, targetHandle: string) {
  const target = await resolveHandle(targetHandle)
  const existed = await removeContact(agentId, target.id)
  if (!existed) {
    throw new ContactError('NOT_FOUND', `@${targetHandle} is not in your contacts`, 404)
  }
}

export async function getContacts(agentId: string, limit = 50, offset = 0) {
  return listContacts(agentId, limit, offset)
}

export async function getContactStatus(agentId: string, targetHandle: string) {
  return checkContact(agentId, targetHandle)
}

export async function setContactNotes(agentId: string, targetHandle: string, notes: string | null) {
  const target = await resolveHandle(targetHandle)
  const existed = await updateContactNotes(agentId, target.id, notes)
  if (!existed) {
    throw new ContactError('NOT_FOUND', `@${targetHandle} is not in your contacts`, 404)
  }
}

export async function block(agentId: string, targetHandle: string) {
  const target = await resolveHandle(targetHandle)

  if (target.id === agentId) {
    throw new ContactError('VALIDATION_ERROR', 'Cannot block yourself', 400)
  }

  await blockAgent(agentId, target.id)

  // Evaluate enforcement thresholds asynchronously (non-blocking).
  // Checks if the target has accumulated enough blocks to be restricted/suspended.
  evaluateEnforcement(target.id).catch((err) => {
    console.error('[enforcement] Failed to evaluate after block:', err)
  })

  // Fire webhook so blocked agent knows (best-effort). Suppress entirely
  // when the target is fully paused by their owner — pause is supposed to
  // be a total silence for incoming push events.
  if (!(await isFullyPaused(target.id))) {
    fireWebhooks(target.id, 'contact.blocked', {
      blocked_by: targetHandle,
    })
  }
}

export async function unblock(agentId: string, targetHandle: string) {
  const target = await resolveHandle(targetHandle)
  const existed = await unblockAgent(agentId, target.id)
  if (!existed) {
    throw new ContactError('NOT_FOUND', `@${targetHandle} is not blocked`, 404)
  }
}

export async function report(agentId: string, targetHandle: string, reason?: string) {
  const target = await resolveHandle(targetHandle)

  if (target.id === agentId) {
    throw new ContactError('VALIDATION_ERROR', 'Cannot report yourself', 400)
  }

  // Prevent duplicate reports from the same reporter
  const alreadyReported = await hasReported(agentId, target.id)
  if (alreadyReported) {
    throw new ContactError('ALREADY_REPORTED', `You have already reported @${targetHandle}`, 409)
  }

  // Auto-block if not already blocked (reporting implies blocking)
  const alreadyBlocked = await isBlocked(agentId, target.id)
  if (!alreadyBlocked) {
    await blockAgent(agentId, target.id)
  }

  const reportId = generateId('rpt')
  await reportAgent(agentId, target.id, reportId, reason)

  // Evaluate enforcement thresholds asynchronously
  evaluateEnforcement(target.id).catch((err) => {
    console.error('[enforcement] Failed to evaluate after report:', err)
  })

  // Same pause gating as block(): suppress the target's webhook entirely
  // if their owner has them in 'full' pause. The auto-block + report row
  // still land in the DB so moderation tooling sees them; only the live
  // push to the (frozen) target is skipped.
  if (!(await isFullyPaused(target.id))) {
    fireWebhooks(target.id, 'contact.blocked', {
      blocked_by: targetHandle,
    })
  }
}

export { isBlocked }
