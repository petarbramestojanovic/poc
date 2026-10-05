import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkMigrations, parseNameStatus } from '../../scripts/migration-guard.ts'

const BASE = ['0001_foundation.sql', '0002_operational_indexes.sql', '0003_read_functions.sql']

describe('checkMigrations', () => {
  it('accepts a new migration after the newest on the base', () => {
    expect(
      checkMigrations({ base: BASE, head: [...BASE, '0004_external_refs.sql'], changed: [] }),
    ).toEqual([])
  })

  it('refuses an edited migration', () => {
    const problems = checkMigrations({
      base: BASE,
      head: BASE,
      changed: [{ status: 'M', name: '0002_operational_indexes.sql' }],
    })
    expect(problems).toEqual([
      '0002_operational_indexes.sql was edited: add the next numbered migration instead',
    ])
  })

  it('refuses a deleted or renamed migration', () => {
    const problems = checkMigrations({
      base: BASE,
      head: ['0001_foundation.sql', '0002_operational_indexes.sql', '0003_reads.sql'],
      changed: [{ status: 'D', name: '0003_read_functions.sql' }],
    })
    expect(problems).toContain(
      '0003_read_functions.sql was deleted or renamed: an applied migration stays as it is',
    )
    // The new name reuses 0003, so it does not sort after the base either.
    expect(problems).toContain(
      '0003_reads.sql does not sort after 0003, the newest migration on the base',
    )
  })

  it('refuses two branches that both added the same number', () => {
    // The base already merged 0004_a; this branch adds 0004_b.
    const problems = checkMigrations({
      base: [...BASE, '0004_a.sql'],
      head: [...BASE, '0004_a.sql', '0004_b.sql'],
      changed: [],
    })
    expect(problems).toContain('0004 is used by more than one file: 0004_a.sql, 0004_b.sql')
  })

  it('refuses a new migration numbered before one the base already has', () => {
    const problems = checkMigrations({
      base: [...BASE, '0005_later.sql'],
      head: [...BASE, '0005_later.sql', '0004_late.sql'],
      changed: [],
    })
    expect(problems).toEqual([
      '0004_late.sql does not sort after 0005, the newest migration on the base',
    ])
  })

  it('refuses a file that is not a numbered migration', () => {
    const problems = checkMigrations({
      base: BASE,
      head: [...BASE, '4_Quick-Fix.sql', 'notes.md'],
      changed: [],
    })
    expect(problems).toEqual([
      '4_Quick-Fix.sql is not named NNNN_snake_case.sql',
      'notes.md is not named NNNN_snake_case.sql',
    ])
  })

  it('passes the repository as it is', () => {
    const head = readdirSync(new URL('../../supabase/migrations', import.meta.url))
    expect(checkMigrations({ base: [], head, changed: [] })).toEqual([])
  })
})

describe('parseNameStatus', () => {
  it('keeps edits, deletions and type changes, drops additions', () => {
    const output = [
      'M\tsupabase/migrations/0002_operational_indexes.sql',
      'D\tsupabase/migrations/0003_read_functions.sql',
      'T\tsupabase/migrations/0001_foundation.sql',
      'A\tsupabase/migrations/0007_new.sql',
      '',
    ].join('\n')
    expect(parseNameStatus(output)).toEqual([
      { status: 'M', name: '0002_operational_indexes.sql' },
      { status: 'D', name: '0003_read_functions.sql' },
      { status: 'T', name: '0001_foundation.sql' },
    ])
  })
})
