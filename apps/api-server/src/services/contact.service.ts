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
  updateTrustScore,
  autoSuspendIfNeeded,
  findAgentByHandle,
} from '@agentchat/db'
import { TRUST_DELTAS, AUTO_SUSPEND_THRESHOLD } from '@agentchat/shared'
import { fireWebhooks } from './webhook.service.js'

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
    throw new ContactError('AGENT_NOT_FOUND', `Agent @${handle} not found`, 404)
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

  // Check if already blocked — idempotent, but only apply trust penalty once
  const alreadyBlocked = await isBlocked(agentId, target.id)
  await blockAgent(agentId, target.id)

  if (!alreadyBlocked) {
    // Trust degradation: blocked agent loses trust (only on first block)
    const newScore = await updateTrustScore(target.id, TRUST_DELTAS.BLOCKED)

    // Auto-suspend if trust score dropped below threshold (when threshold is configured)
    if (AUTO_SUSPEND_THRESHOLD !== null && newScore <= AUTO_SUSPEND_THRESHOLD) {
      await autoSuspendIfNeeded(target.id, AUTO_SUSPEND_THRESHOLD)
    }
  }

  // Fire webhook so blocked agent knows (best-effort)
  fireWebhooks(target.id, 'contact.blocked', {
    blocked_by: targetHandle, // don't expose who blocked — just notify
  })
}

export async function unblock(agentId: string, targetHandle: string) {
  const target = await resolveHandle(targetHandle)
  const existed = await unblockAgent(agentId, target.id)
  if (!existed) {
    throw new ContactError('NOT_FOUND', `@${targetHandle} is not blocked`, 404)
  }

  // Restore trust: reverse the block penalty (trust is temporary, not permanent)
  await updateTrustScore(target.id, -TRUST_DELTAS.BLOCKED)
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
    await updateTrustScore(target.id, TRUST_DELTAS.BLOCKED)
  }

  const reportId = generateId('rpt')
  await reportAgent(agentId, target.id, reportId, reason)

  // Trust degradation: reported agent loses more trust
  const newScore = await updateTrustScore(target.id, TRUST_DELTAS.REPORTED)

  // Auto-suspend if trust score dropped below threshold (when threshold is configured)
  if (AUTO_SUSPEND_THRESHOLD !== null && newScore <= AUTO_SUSPEND_THRESHOLD) {
    await autoSuspendIfNeeded(target.id, AUTO_SUSPEND_THRESHOLD)
  }

  // Fire webhook so blocked agent knows
  fireWebhooks(target.id, 'contact.blocked', {
    blocked_by: targetHandle,
  })
}

export { isBlocked }
