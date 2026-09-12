import { readFileSync } from 'node:fs'

// Queries live in `sql/<name>.sql` next to the module that runs them (plan rule: SQL in files,
// parameters only). Files are read once, on first use at startup, and cached.
const cache = new Map<string, string>()

export function sqlFile(moduleUrl: string, name: string): string {
  const url = new URL(`./sql/${name}.sql`, moduleUrl)
  const key = url.href
  let text = cache.get(key)
  if (text === undefined) {
    text = readFileSync(url, 'utf8')
    cache.set(key, text)
  }
  return text
}
