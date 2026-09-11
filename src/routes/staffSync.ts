import type { FastifyInstance } from 'fastify'
import { getPool } from '../db/client.js'
import { requireStoreAuth } from '../lib/storeAuth.js'

interface StaffSyncEntry {
  localId: number
  name: string
  role: string
  active: boolean
  updatedAt: string
  /** Always present from a real till (every local staff row has one) — only ever consumed when
   *  this push is the *first* time this store's local_id is seen (a brand-new central staff
   *  row), never used to overwrite an existing one. That's what lets a staff member created on
   *  one self-hosted store show up with a genuinely working login on another store once it
   *  pulls this down — bcryptjs hashes are portable, no re-hashing needed. A password *reset*
   *  deliberately does not propagate this way; that's a separate, harder problem (which store's
   *  reset should win?) not attempted here. */
  passwordHash: string
}

interface SyncBody {
  staff: StaffSyncEntry[]
}

interface ClaimBody {
  claims: Array<{ centralId: number; localId: number }>
}

const ROLES = new Set(['owner', 'manager', 'cashier'])

/** Same protocol and per-store mapping design as routes/catalog.ts — see that file's top
 *  comment for the fuller reasoning on why identity is resolved through a mapping table
 *  (`staff_stores`) instead of a bare `local_id` column. */
export async function registerStaffSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SyncBody }>(
    '/v1/staff/sync',
    {
      schema: {
        body: {
          type: 'object',
          required: ['staff'],
          properties: {
            staff: {
              type: 'array',
              items: {
                type: 'object',
                required: ['localId', 'name', 'role', 'active', 'updatedAt', 'passwordHash'],
                properties: {
                  localId: { type: 'number' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  active: { type: 'boolean' },
                  updatedAt: { type: 'string' },
                  passwordHash: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = await requireStoreAuth(request, reply)
      if (!auth) return

      const invalid = request.body.staff.find((s) => !ROLES.has(s.role))
      if (invalid) return reply.code(400).send({ error: `Invalid role: ${invalid.role}` })

      const pool = getPool()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const s of request.body.staff) {
          const { rows: linkRows } = await client.query<{ staff_id: number }>(
            'SELECT staff_id FROM staff_stores WHERE store_id = $1 AND local_id = $2',
            [auth.storeId, s.localId],
          )
          const link = linkRows[0]

          if (!link) {
            const { rows } = await client.query<{ id: number }>(
              'INSERT INTO staff (name, role, active, password_hash, updated_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
              [s.name, s.role, s.active, s.passwordHash, s.updatedAt],
            )
            await client.query('INSERT INTO staff_stores (store_id, local_id, staff_id) VALUES ($1, $2, $3)', [
              auth.storeId,
              s.localId,
              rows[0]!.id,
            ])
          } else {
            await client.query(
              `UPDATE staff SET name = $1, role = $2, active = $3, updated_at = $4
               WHERE id = $5 AND updated_at < $4`,
              [s.name, s.role, s.active, s.updatedAt, link.staff_id],
            )
          }
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        request.log.error(err, 'staff sync failed')
        return reply.code(500).send({ error: 'internal error' })
      } finally {
        client.release()
      }

      return reply.send({ synced: request.body.staff.length })
    },
  )

  app.get('/v1/staff/pull', async (request, reply) => {
    const auth = await requireStoreAuth(request, reply)
    if (!auth) return

    const pool = getPool()
    const { rows } = await pool.query<{
      id: number
      local_id: number | null
      name: string
      role: string
      active: boolean
      updated_at: string
      password_hash: string
    }>(
      `SELECT s.id, ss.local_id, s.name, s.role, s.active, s.updated_at, s.password_hash
       FROM staff s
       LEFT JOIN staff_stores ss ON ss.staff_id = s.id AND ss.store_id = $1
       ORDER BY s.name ASC`,
      [auth.storeId],
    )

    return reply.send({
      staff: rows.map((r) => ({
        id: r.id,
        localId: r.local_id,
        name: r.name,
        role: r.role,
        active: r.active,
        updatedAt: r.updated_at,
        passwordHash: r.password_hash,
      })),
    })
  })

  app.post<{ Body: ClaimBody }>(
    '/v1/staff/claim',
    {
      schema: {
        body: {
          type: 'object',
          required: ['claims'],
          properties: {
            claims: {
              type: 'array',
              items: {
                type: 'object',
                required: ['centralId', 'localId'],
                properties: { centralId: { type: 'number' }, localId: { type: 'number' } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = await requireStoreAuth(request, reply)
      if (!auth) return

      const pool = getPool()
      let claimed = 0
      for (const claim of request.body.claims) {
        try {
          await pool.query(
            `INSERT INTO staff_stores (store_id, local_id, staff_id) VALUES ($1, $2, $3)
             ON CONFLICT (store_id, local_id) DO UPDATE SET staff_id = excluded.staff_id`,
            [auth.storeId, claim.localId, claim.centralId],
          )
          claimed++
        } catch (err) {
          request.log.error(err, 'staff claim skipped')
        }
      }
      return reply.send({ claimed })
    },
  )
}
