import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getPool } from '../db/client.js'

/** Generated once per store, at registration (routes/setup.ts) — never regenerated. */
export function generateStoreToken(): string {
  return randomBytes(32).toString('hex')
}

export interface AuthenticatedStore {
  storeId: number
}

/** Verifies the `Authorization: Bearer <token>` header against `stores.api_token` — every till
 *  that's registered against this deployment gets its own token, same pattern as Gramobiz's own
 *  hosted backend's per-store authentication (backend/src/lib/storeAuth.ts). Sends a 401 and
 *  returns null on failure; callers must return immediately in that case. */
export async function requireStoreAuth(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedStore | null> {
  const header = request.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  if (!token) {
    reply.code(401).send({ error: 'Missing or invalid Authorization header.' })
    return null
  }

  const pool = getPool()
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM stores WHERE api_token = $1', [token])
  const store = rows[0]
  if (!store) {
    reply.code(401).send({ error: 'Invalid or expired token.' })
    return null
  }
  return { storeId: store.id }
}
