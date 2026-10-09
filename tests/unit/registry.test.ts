import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RegistryMismatchError } from '../../src/modules/sync/errors.ts'
import {
  assertRegistryMatchesSources,
  createRegistry,
  UnknownSourceError,
} from '../../src/modules/sync/registry.ts'
import type { SourceConnector } from '../../src/modules/sync/types.ts'

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
  fetchWindow: () => Promise.resolve({ rows: [], warnings: [], covered: null }),
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

  it('rejects a duplicate connector id instead of silently overwriting it', () => {
    expect(() => createRegistry([stub('nexd'), stub('nexd')])).toThrow(RegistryMismatchError)
  })

  it('boot check: registry and enabled platform sources must match in both directions', () => {
    const registry = createRegistry([stub('nexd'), stub('zeus')])
    expect(() => {
      assertRegistryMatchesSources(registry, ['zeus', 'nexd'])
    }).not.toThrow()
    expect(() => {
      assertRegistryMatchesSources(registry, ['nexd', 'zeus', 'adform'])
    }).toThrow('no connector for: adform')
    expect(() => {
      assertRegistryMatchesSources(registry, ['nexd'])
    }).toThrow('no enabled platform source row for: zeus')
  })
})
