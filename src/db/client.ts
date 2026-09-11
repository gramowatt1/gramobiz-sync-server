import pg from 'pg'
import { migrations } from './migrations/index.js'

const { Pool, types } = pg

// Same fix as Gramobiz's own backend (backend/src/db/client.ts) — BIGINT/BIGSERIAL columns
// (OID 20) come back as strings by default to avoid silently losing precision above
// Number.MAX_SAFE_INTEGER, but nothing in this schema is realistically near that scale and
// every route/type here declares ids as `number`.
types.setTypeParser(20, (value: string) => parseInt(value, 10))

let pool: pg.Pool | null = null

/** Opens (lazily, once) the connection pool and brings the schema up to date. Deliberately the
 *  same "migrations are append-only, tracked by name in a _migrations table" discipline as
 *  Gramobiz's own backend and the till app itself — same reasoning, different database. */
export function getPool(): pg.Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set — see .env.example')

  pool = new Pool({ connectionString })
  return pool
}

export async function runMigrations(db: pg.Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const { rows: appliedRows } = await db.query<{ name: string }>('SELECT name FROM _migrations')
  const applied = new Set(appliedRows.map((row) => row.name))

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(migration.sql)
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${migration.name} failed: ${(err as Error).message}`)
    } finally {
      client.release()
    }
  }
}

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = null
}
