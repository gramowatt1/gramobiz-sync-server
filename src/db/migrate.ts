// Standalone entrypoint: `npm run migrate`. Brings whatever DATABASE_URL points at up to the
// latest schema, then exits.
import 'dotenv/config'
import { getPool, runMigrations, closePool } from './client.js'

const pool = getPool()
await runMigrations(pool)
console.log('Migrations up to date.')
await closePool()
