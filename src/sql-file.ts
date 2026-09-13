import { readFileSync } from 'node:fs'

// Queries live in `sql/<name>.sql` next to the module that runs them (plan rule: SQL in files,
// parameters only). They are read EAGERLY, at module import time, so a missing or un-copied
// file fails the boot rather than the first nightly run at 04:00. The returned object is typed
// over the names given, so an unknown statement name is a compile error.

export type SqlStatements<N extends readonly string[]> = Readonly<Record<N[number], string>>

export class SqlFileError extends Error {
  override readonly name = 'SqlFileError'
}

export function loadSql<const N extends readonly string[]>(
  moduleUrl: string,
  names: N,
): SqlStatements<N> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const url = new URL(`./sql/${name}.sql`, moduleUrl)
    try {
      out[name] = readFileSync(url, 'utf8')
    } catch (cause) {
      throw new SqlFileError(`Cannot read SQL file ${url.pathname}`, { cause })
    }
  }
  return out as SqlStatements<N>
}
