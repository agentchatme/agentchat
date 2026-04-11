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
  await removeContact(agentId, target.id)
}

export async function getContacts(agentId: string, limit = 50, offset = 0) {
  return listContacts(agentId, limit, offset)
}

export async function block(agentId: string, targetHandle: string) {
  const target = await resolveHandle(targetHandle)

  if (target.id === agentId) {
    throw new ContactError('VALIDATION_ERROR', 'Cannot block yourself', 400)
  }

  await blockAgent(agentId, target.id)

  // Trust degradation: blocked agent loses trust
  const newScore = await updateTrustScore(target.id, TRUST_DELTAS.BLOCKED)

  // Auto-suspend if trust score dropped below threshold
  if (newScore <= AUTO_SUSPEND_THRESHOLD) {
    await autoSuspendIfNeeded(target.id, AUTO_SUSPEND_THRESHOLD)
  }
}

export async function unblock(agentId: string, targetHandle: string) {
  const target = await resolveHandle(targetHandle)
  await unblockAgent(agentId, target.id)
}

export async function report(agentId: string, targetHandle: string, reason?: string) {
  const target = await resolveHandle(targetHandle)

  if (target.id === agentId) {
    throw new ContactError('VALIDATION_ERROR', 'Cannot report yourself', 400)
  }

  // Check if already blocked — if not, auto-block (reporting implies blocking)
  const alreadyBlocked = await isBlocked(agentId, target.id)
  if (!alreadyBlocked) {
    await blockAgent(agentId, target.id)
    await updateTrustScore(target.id, TRUST_DELTAS.BLOCKED)
  }

  const reportId = generateId('rpt')
  await reportAgent(agentId, target.id, reportId, reason)

  // Trust degradation: reported agent loses more trust
  const newScore = await updateTrustScore(target.id, TRUST_DELTAS.REPORTED)

  // Auto-suspend if trust score dropped below threshold
  if (newScore <= AUTO_SUSPEND_THRESHOLD) {
    await autoSuspendIfNeeded(target.id, AUTO_SUSPEND_THRESHOLD)
  }
}

export { isBlocked }
