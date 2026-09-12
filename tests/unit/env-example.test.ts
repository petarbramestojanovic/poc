import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// Every variable the service reads must be documented in .env.example.
const REQUIRED = [
  'DATABASE_URL',
  'NEXD_API_KEY',
  'ZEUS_API_TOKEN',
  'SERVICE_ADMIN_TOKEN',
  'PORT',
  'LOG_LEVEL',
  'TZ',
]

describe('.env.example', () => {
  it('declares every required variable', async () => {
    const text = await readFile(new URL('../../.env.example', import.meta.url), 'utf8')
    const declared = new Set(
      text
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.startsWith('#'))
        .map((line) => line.slice(0, line.indexOf('='))),
    )
    for (const name of REQUIRED) expect(declared, `missing ${name}`).toContain(name)
  })

  it('pins TZ to UTC', async () => {
    const text = await readFile(new URL('../../.env.example', import.meta.url), 'utf8')
    expect(text).toMatch(/^TZ=UTC$/m)
  })
})
