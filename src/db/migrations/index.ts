import { sql as m001 } from './001_init.js'

export interface Migration {
  name: string
  sql: string
}

// Ordered oldest -> newest. Add new migrations by appending here, never by editing an
// already-applied one — the runner tracks what's been applied by name. Same discipline as
// Gramobiz's own backend and the till app itself.
export const migrations: Migration[] = [{ name: '001_init', sql: m001 }]
