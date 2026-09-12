import { existsSync } from 'node:fs'
import { Client } from 'pg'

// Runs once before the integration project. Loads .env (without overriding the shell),
// then refuses to start unless the local Supabase Postgres is reachable and migrated.
export default async function globalSetup(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')

  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Run `npx supabase start`, put its DB URL in .env, then `npm run db:reset`.',
    )
  }

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    )
    if (rows.length === 0) throw new Error('No migrations applied. Run `npm run db:reset`.')
  } finally {
    await client.end()
  }
}
