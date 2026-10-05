// Fails when supabase/migrations/ breaks the append-only rule against a base ref.
//   npm run check:migrations -- origin/main
// CI passes the PR's base (the merge commit's first parent) or the commit before a push.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkMigrations, parseNameStatus } from './migration-guard.ts'

const DIR = 'supabase/migrations'
const root = fileURLToPath(new URL('..', import.meta.url))
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

const base = process.argv[2]
if (base === undefined || base === '') {
  process.stderr.write('usage: npm run check:migrations -- <base-ref>\n')
  process.exit(2)
}

const problems = checkMigrations({
  base: git('ls-tree', '--name-only', `${base}:${DIR}`).split('\n').filter(Boolean),
  head: readdirSync(new URL(`../${DIR}`, import.meta.url)),
  // Against the working tree, so an uncommitted edit fails locally too.
  changed: parseNameStatus(git('diff', '--name-status', '--no-renames', base, '--', DIR)),
})

if (problems.length > 0) {
  process.stderr.write(`${DIR} is append-only (compared with ${base}):\n`)
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.exit(1)
}
process.stdout.write(`migrations: append-only against ${base}\n`)
