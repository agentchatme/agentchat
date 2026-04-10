import { generateId } from '../lib/id.js'
import {
  addContact,
  removeContact,
  listContacts,
  isBlocked,
  blockAgent,
  unblockAgent,
  reportAgent,
  updateTrustScore,
  autoSuspendIfNeeded,
  findAgentById,
  findAgentByHandle,
} from '@agentchat/db'
import { TRUST_DELTAS, AUTO_SUSPEND_THRESHOLD } from '@agentchat/shared'

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

function resolveAgent(idOrHandle: string) {
  return idOrHandle.startsWith('agt_')
    ? findAgentById(idOrHandle)
    : findAgentByHandle(idOrHandle.replace(/^@/, ''))
}

export async function addToContacts(agentId: string, targetIdOrHandle: string) {
  const target = await resolveAgent(targetIdOrHandle)
  if (!target) {
    throw new ContactError('AGENT_NOT_FOUND', `Agent ${targetIdOrHandle} not found`, 404)
  }

  if (target.id === agentId) {
    throw new ContactError('VALIDATION_ERROR', 'Cannot add yourself as a contact', 400)
  }

  await addContact(agentId, target.id)
  return { agent_id: target.id, handle: target.handle, display_name: target.display_name }
}

export async function removeFromContacts(agentId: string, targetAgentId: string) {
  await removeContact(agentId, targetAgentId)
}

export async function getContacts(agentId: string) {
  return listContacts(agentId)
}

export async function block(agentId: string, targetAgentId: string) {
  const target = await findAgentById(targetAgentId)
  if (!target) {
    throw new ContactError('AGENT_NOT_FOUND', `Agent ${targetAgentId} not found`, 404)
  }

  if (target.id === agentId) {
    throw new ContactError('VALIDATION_ERROR', 'Cannot block yourself', 400)
  }

  await blockAgent(agentId, targetAgentId)

  // Trust degradation: blocked agent loses trust
  const newScore = await updateTrustScore(targetAgentId, TRUST_DELTAS.BLOCKED)

  // Auto-suspend if trust score dropped below threshold
  if (newScore <= AUTO_SUSPEND_THRESHOLD) {
    await autoSuspendIfNeeded(targetAgentId, AUTO_SUSPEND_THRESHOLD)
  }
}

export async function unblock(agentId: string, targetAgentId: string) {
  await unblockAgent(agentId, targetAgentId)
}

export async function report(agentId: string, targetAgentId: string, reason?: string) {
  const target = await findAgentById(targetAgentId)
  if (!target) {
    throw new ContactError('AGENT_NOT_FOUND', `Agent ${targetAgentId} not found`, 404)
  }

  if (target.id === agentId) {
    throw new ContactError('VALIDATION_ERROR', 'Cannot report yourself', 400)
  }

  // Check if already blocked — if not, auto-block (reporting implies blocking)
  const alreadyBlocked = await isBlocked(agentId, targetAgentId)
  if (!alreadyBlocked) {
    await blockAgent(agentId, targetAgentId)
    await updateTrustScore(targetAgentId, TRUST_DELTAS.BLOCKED)
  }

  const reportId = generateId('rpt')
  await reportAgent(agentId, targetAgentId, reportId, reason)

  // Trust degradation: reported agent loses more trust
  const newScore = await updateTrustScore(targetAgentId, TRUST_DELTAS.REPORTED)

  // Auto-suspend if trust score dropped below threshold
  if (newScore <= AUTO_SUSPEND_THRESHOLD) {
    await autoSuspendIfNeeded(targetAgentId, AUTO_SUSPEND_THRESHOLD)
  }
}

export { isBlocked }
