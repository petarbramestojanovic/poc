import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadSql, SqlFileError } from '../../src/sql-file.ts'

function moduleWithSql(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sql-file-'))
  mkdirSync(join(dir, 'sql'))
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, 'sql', `${name}.sql`), text)
  return pathToFileURL(join(dir, 'module.js')).href
}

describe('loadSql', () => {
  it('reads every named statement eagerly into a typed object', () => {
    const url = moduleWithSql({ a: 'SELECT 1', b: 'SELECT 2' })
    const sql = loadSql(url, ['a', 'b'] as const)
    expect(sql).toEqual({ a: 'SELECT 1', b: 'SELECT 2' })
  })

  it('fails at load time, naming the file, when a statement is missing', () => {
    const url = moduleWithSql({ a: 'SELECT 1' })
    expect(() => loadSql(url, ['a', 'missing'] as const)).toThrow(SqlFileError)
    expect(() => loadSql(url, ['a', 'missing'] as const)).toThrow('missing.sql')
  })

  it('loads the real sync statements at import time', async () => {
    await expect(import('../../src/sync/repo.ts')).resolves.toBeDefined()
    await expect(import('../../src/sync/writer.ts')).resolves.toBeDefined()
  })
})
