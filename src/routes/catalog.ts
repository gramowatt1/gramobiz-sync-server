import type { FastifyInstance } from 'fastify'
import { getPool } from '../db/client.js'
import { requireStoreAuth } from '../lib/storeAuth.js'

interface WireSaleUnit {
  label: string
  factor: number
  price: number
  isDefault: boolean
  barcode: string | null
}

interface SyncProduct {
  localId: number
  name: string
  category: string
  baseUnit: string
  costPrice: number
  barcode: string | null
  active: boolean
  updatedAt: string
  saleUnits: WireSaleUnit[]
}

interface SyncBody {
  products: SyncProduct[]
}

interface ClaimBody {
  claims: Array<{ catalogProductId: number; localId: number }>
}

const saleUnitSchema = {
  type: 'object',
  required: ['label', 'factor', 'price', 'isDefault'],
  properties: {
    label: { type: 'string', minLength: 1 },
    factor: { type: 'number', exclusiveMinimum: 0 },
    price: { type: 'number', minimum: 0 },
    isDefault: { type: 'boolean' },
    barcode: { type: ['string', 'null'] },
  },
} as const

/**
 * The exact same wire protocol as Gramobiz's own hosted `routes/catalog.ts`
 * (`electron/services/catalogSync.ts` on the till side neither knows nor cares which server it's
 * pointed at) — whole-product-bundle sync, last-write-wins by `updatedAt`, a product's sale
 * units always travel and get replaced as one unit with it, never tracked individually. The one
 * real difference from Gramobiz's hosted version: identity is resolved through the per-store
 * `catalog_product_stores` mapping table (see migration 001_init.ts) instead of a bare `local_id`
 * column, since this deployment may genuinely serve more than one of the customer's own stores.
 */
export async function registerCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SyncBody }>(
    '/v1/catalog/sync',
    {
      schema: {
        body: {
          type: 'object',
          required: ['products'],
          properties: {
            products: {
              type: 'array',
              items: {
                type: 'object',
                required: ['localId', 'name', 'category', 'baseUnit', 'costPrice', 'active', 'updatedAt', 'saleUnits'],
                properties: {
                  localId: { type: 'number' },
                  name: { type: 'string' },
                  category: { type: 'string' },
                  baseUnit: { type: 'string' },
                  costPrice: { type: 'number' },
                  barcode: { type: ['string', 'null'] },
                  active: { type: 'boolean' },
                  updatedAt: { type: 'string' },
                  saleUnits: { type: 'array', items: saleUnitSchema },
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

      const pool = getPool()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const p of request.body.products) {
          const { rows: linkRows } = await client.query<{ catalog_product_id: number }>(
            'SELECT catalog_product_id FROM catalog_product_stores WHERE store_id = $1 AND local_id = $2',
            [auth.storeId, p.localId],
          )
          const link = linkRows[0]

          let catalogProductId: number
          if (!link) {
            const { rows } = await client.query<{ id: number }>(
              `INSERT INTO catalog_products (name, category, base_unit, cost_price, barcode, active, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
              [p.name, p.category, p.baseUnit, p.costPrice, p.barcode, p.active, p.updatedAt],
            )
            catalogProductId = rows[0]!.id
            await client.query('INSERT INTO catalog_product_stores (store_id, local_id, catalog_product_id) VALUES ($1, $2, $3)', [
              auth.storeId,
              p.localId,
              catalogProductId,
            ])
          } else {
            const { rows: existingRows } = await client.query<{ updated_at: string }>(
              'SELECT updated_at FROM catalog_products WHERE id = $1',
              [link.catalog_product_id],
            )
            const existing = existingRows[0]
            if (!existing || p.updatedAt <= existing.updated_at) continue // central is at least as new — leave it
            catalogProductId = link.catalog_product_id
            await client.query(
              `UPDATE catalog_products SET name = $1, category = $2, base_unit = $3, cost_price = $4, barcode = $5, active = $6, updated_at = $7
               WHERE id = $8`,
              [p.name, p.category, p.baseUnit, p.costPrice, p.barcode, p.active, p.updatedAt, catalogProductId],
            )
          }

          await client.query('DELETE FROM catalog_sale_units WHERE catalog_product_id = $1', [catalogProductId])
          for (const u of p.saleUnits) {
            await client.query(
              `INSERT INTO catalog_sale_units (catalog_product_id, label, factor, price, is_default, barcode, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [catalogProductId, u.label, u.factor, u.price, u.isDefault, u.barcode, p.updatedAt],
            )
          }
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        request.log.error(err, 'catalog sync failed')
        return reply.code(500).send({ error: 'internal error' })
      } finally {
        client.release()
      }

      return reply.send({ synced: request.body.products.length })
    },
  )

  app.get('/v1/catalog/pull', async (request, reply) => {
    const auth = await requireStoreAuth(request, reply)
    if (!auth) return

    const pool = getPool()
    // The whole shared catalog, not just what this store has linked to — that's the entire
    // point of several stores syncing to one deployment. `local_id` is null for a product this
    // particular store has never seen (created directly here, or pushed by a different store).
    const { rows: products } = await pool.query<{
      id: number
      local_id: number | null
      name: string
      category: string
      base_unit: string
      cost_price: string
      barcode: string | null
      active: boolean
      updated_at: string
    }>(
      `SELECT cp.id, cps.local_id, cp.name, cp.category, cp.base_unit, cp.cost_price, cp.barcode, cp.active, cp.updated_at
       FROM catalog_products cp
       LEFT JOIN catalog_product_stores cps ON cps.catalog_product_id = cp.id AND cps.store_id = $1
       ORDER BY cp.name ASC`,
      [auth.storeId],
    )

    const { rows: saleUnits } = await pool.query<{
      catalog_product_id: number
      label: string
      factor: string
      price: string
      is_default: boolean
      barcode: string | null
    }>('SELECT catalog_product_id, label, factor, price, is_default, barcode FROM catalog_sale_units ORDER BY factor ASC')
    const unitsByProduct = new Map<number, WireSaleUnit[]>()
    for (const u of saleUnits) {
      const list = unitsByProduct.get(u.catalog_product_id) ?? []
      list.push({ label: u.label, factor: Number(u.factor), price: Number(u.price), isDefault: u.is_default, barcode: u.barcode })
      unitsByProduct.set(u.catalog_product_id, list)
    }

    return reply.send({
      products: products.map((p) => ({
        id: p.id,
        localId: p.local_id,
        name: p.name,
        category: p.category,
        baseUnit: p.base_unit,
        costPrice: Number(p.cost_price),
        barcode: p.barcode,
        active: p.active,
        updatedAt: p.updated_at,
        saleUnits: unitsByProduct.get(p.id) ?? [],
      })),
    })
  })

  app.post<{ Body: ClaimBody }>(
    '/v1/catalog/claim',
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
                required: ['catalogProductId', 'localId'],
                properties: { catalogProductId: { type: 'number' }, localId: { type: 'number' } },
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
            `INSERT INTO catalog_product_stores (store_id, local_id, catalog_product_id) VALUES ($1, $2, $3)
             ON CONFLICT (store_id, local_id) DO UPDATE SET catalog_product_id = excluded.catalog_product_id`,
            [auth.storeId, claim.localId, claim.catalogProductId],
          )
          claimed++
        } catch (err) {
          // A unique_violation on (store_id, catalog_product_id) means this store already has a
          // *different* local_id linked to the same central product — a genuine conflict worth
          // skipping rather than failing the whole batch over.
          request.log.error(err, 'catalog claim skipped')
        }
      }
      return reply.send({ claimed })
    },
  )
}
