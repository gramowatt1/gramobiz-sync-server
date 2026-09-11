import 'dotenv/config'
import Fastify from 'fastify'
import { getPool, runMigrations } from './db/client.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerSetupRoutes } from './routes/setup.js'
import { registerCatalogRoutes } from './routes/catalog.js'
import { registerStaffSyncRoutes } from './routes/staffSync.js'

const app = Fastify({ logger: true })

await registerHealthRoutes(app)
await registerSetupRoutes(app)
await registerCatalogRoutes(app)
await registerStaffSyncRoutes(app)

// Bring the database up to date on boot, same as Gramobiz's own backend and the till app itself.
await runMigrations(getPool())

const port = Number(process.env.PORT ?? 4100)
await app.listen({ port, host: '0.0.0.0' })
