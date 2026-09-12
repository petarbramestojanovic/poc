import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRegistry, UnknownSourceError } from '../../src/sync/registry.ts'
import type { SourceConnector } from '../../src/sync/types.ts'

const stub = (id: string): SourceConnector => ({
  id,
  capabilities: {
    granularity: 'daily',
    restatementWindowDays: 7,
    maxWindowDays: 21,
    verifiesAgainstTotals: false,
  },
  identity: { levels: ['creative'], multiple: true },
  describe: () => ({ configSchema: z.object({}) }),
  checkConnection: () => Promise.resolve({ ok: true, message: 'stub' }),
  fetchWindow: () => Promise.resolve({ rows: [], raw: [], warnings: [] }),
})

describe('connector registry', () => {
  it('returns registered connectors by source id', () => {
    const registry = createRegistry([stub('nexd'), stub('zeus')])
    expect(registry.get('zeus').id).toBe('zeus')
    expect(registry.ids()).toEqual(['nexd', 'zeus'])
  })

  it('throws a typed error for an unknown source id', () => {
    const registry = createRegistry([stub('nexd')])
    expect(() => registry.get('adnuntius')).toThrow(UnknownSourceError)
    expect(() => registry.get('adnuntius')).toThrow("source 'adnuntius' (known: nexd)")
  })
})
