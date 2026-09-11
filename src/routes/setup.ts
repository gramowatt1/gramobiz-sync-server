import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { getPool } from '../db/client.js'
import { generateStoreToken } from '../lib/storeAuth.js'

interface RegisterBody {
  name: string
}

/** The one credential a self-hoster sets themselves when deploying this (an env var, prompted
 *  for during a Render Blueprint deploy or set by hand in a .env for a manual/Docker deploy) —
 *  there's no "Owner web login" here to authenticate against otherwise, since this package has
 *  no concept of accounts at all. Constant-time comparison, same reasoning as any other shared
 *  secret gate in this codebase (Gramobiz's own ADMIN_API_KEY). */
function requireSetupKey(headerValue: string | undefined): boolean {
  const expected = process.env.SETUP_KEY
  if (!expected) return false
  if (!headerValue) return false
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(headerValue, 'utf8')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

/**
 * Registers a new till against this deployment — the self-hosted equivalent of Gramobiz's own
 * `POST /v1/licenses/activate`, minus everything about licensing: no code to redeem, no tier, no
 * store-slot limit. Every store registered here shares the exact same catalog and staff roster
 * (see migration 001_init.ts's per-store mapping tables) — there is no plan/tier concept to gate
 * how many a customer can add, since they're the ones running the server.
 */
export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterBody }>(
    '/v1/stores/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      if (!requireSetupKey(request.headers['x-setup-key'] as string | undefined)) {
        return reply.code(401).send({ error: 'Invalid or missing setup key.' })
      }
      if (!process.env.SETUP_KEY) {
        return reply.code(500).send({ error: 'SETUP_KEY is not configured on this server — see .env.example.' })
      }

      const pool = getPool()
      const apiToken = generateStoreToken()
      const { rows } = await pool.query<{ id: number; created_at: string }>(
        'INSERT INTO stores (name, api_token) VALUES ($1, $2) RETURNING id, created_at',
        [request.body.name.trim(), apiToken],
      )
      const store = rows[0]!
      return reply.send({ storeId: store.id, name: request.body.name.trim(), apiToken, createdAt: store.created_at })
    },
  )
}
