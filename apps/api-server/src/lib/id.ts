import { randomBytes } from 'node:crypto'

type Prefix = 'agt' | 'msg' | 'conv' | 'grp' | 'whk' | 'whd' | 'rpt' | 'pnd'

export function generateId(prefix: Prefix): string {
  const bytes = randomBytes(12)
  return `${prefix}_${bytes.toString('base64url')}`
}
