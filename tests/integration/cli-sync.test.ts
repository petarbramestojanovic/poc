import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/core/db.ts'

// The real CLI process against the local database. Its environment carries no platform keys, so
// every case stops before any network call: this proves the wiring (arguments, config, runtime,
// registry check, database) without touching NEXD or Zeus. The environment is built explicitly
// so keys loaded from your .env never reach the child.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ENV = {
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  DATABASE_SSL: 'disable',
  TZ: 'UTC',
  LOG_LEVEL: 'silent',
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

function cli(...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['src/cli/sync.ts', ...args],
      { cwd: ROOT, env: ENV },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
      },
    )
  })
}

async function lastChecked(credentialName: string): Promise<string | null> {
  const db = createDb(ENV.DATABASE_URL, { ssl: 'disable', max: 1 })
  try {
    const [row] = await db.query<{ checked: string | null }>(
      'SELECT last_checked_at::text AS checked FROM external.credential WHERE name = $1',
      [credentialName],
    )
    return row?.checked ?? null
  } finally {
    await db.close()
  }
}

describe('sync CLI', () => {
  it('prints usage for --help', async () => {
    const result = await cli('--help')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('npm run sync -- --link <link id>')
  })

  it('rejects conflicting modes with exit code 2 before touching the database', async () => {
    const result = await cli('--all', '--link', 'x')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Choose only one of --link, --all')
  })

  it('reports an unknown link and exits 1', async () => {
    const result = await cli('--link', '00000000-0000-4000-8000-0000000000ff', '--dry-run')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('[link_not_found]')
    expect(result.stderr).toContain('does not exist')
  })

  it('refuses to check a credential whose key is not set, and records nothing', async () => {
    const before = await lastChecked('nexd-main')

    const result = await cli('--check-connection', 'nexd-main')

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Cannot use credential nexd/nexd-main')
    expect(result.stderr).toContain('NEXD_API_KEY is not set')
    expect(await lastChecked('nexd-main')).toBe(before)
  })

  it('reports a credential that does not exist', async () => {
    const result = await cli('--check-connection', 'no-such-credential')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('No credential has the name or id no-such-credential.')
  })

  it('needs the Zeus token to list pixels', async () => {
    const result = await cli('--source', 'zeus', '--list-pixels', '--credential', 'zeus-main')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ZEUS_API_TOKEN is not set')
  })
})
