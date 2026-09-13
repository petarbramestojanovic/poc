import { cpSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// tsc emits only JavaScript; the `sql/` directories loaded by src/sql-file.ts are copied
// alongside. Only those directories are copied — nothing else from src/ reaches dist/.
function sqlDirs(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    if (entry.name === 'sql') found.push(path)
    else found.push(...sqlDirs(path))
  }
  return found
}

for (const dir of sqlDirs('src')) {
  cpSync(dir, join('dist', relative('src', dir)), { recursive: true })
}
