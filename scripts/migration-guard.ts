// The rules behind `npm run check:migrations`. Pure, so tests/unit/migration-guard.test.ts can
// trip each one without a git repository.

/** `NNNN_snake_case.sql`: the number orders them, `supabase db push` applies them by it. */
const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/

/** One line of `git diff --name-status --no-renames <base> -- supabase/migrations`. */
export interface MigrationChange {
  readonly status: string
  readonly name: string
}

export interface MigrationTree {
  /** File names in `supabase/migrations/` on the base: what is (or will be) applied already. */
  readonly base: readonly string[]
  /** File names in `supabase/migrations/` now. */
  readonly head: readonly string[]
  /** Base files whose content differs now. Additions are not changes. */
  readonly changed: readonly MigrationChange[]
}

/** Parses `git diff --name-status --no-renames` output into changes of existing files. */
export function parseNameStatus(output: string): MigrationChange[] {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [status = '', path = ''] = line.split('\t')
      return { status: status.charAt(0), name: path.slice(path.lastIndexOf('/') + 1) }
    })
    .filter((change) => change.status !== 'A')
}

function version(name: string): string | undefined {
  return MIGRATION_NAME.exec(name)?.[1]
}

/**
 * Migrations are append-only: an applied migration is never edited, renamed or deleted, and a
 * new one sorts after every migration on the base, so two branches cannot both add `0007_`.
 * Returns one message per violation; empty means the tree is fine.
 */
export function checkMigrations({ base, head, changed }: MigrationTree): string[] {
  const problems: string[] = []

  for (const { status, name } of changed) {
    problems.push(
      status === 'D'
        ? `${name} was deleted or renamed: an applied migration stays as it is`
        : `${name} was edited: add the next numbered migration instead`,
    )
  }

  const byVersion = new Map<string, string[]>()
  for (const name of head) {
    const v = version(name)
    if (v === undefined) {
      problems.push(`${name} is not named NNNN_snake_case.sql`)
      continue
    }
    byVersion.set(v, [...(byVersion.get(v) ?? []), name])
  }
  for (const [v, names] of byVersion) {
    if (names.length > 1) problems.push(`${v} is used by more than one file: ${names.join(', ')}`)
  }

  const newest = base
    .map(version)
    .filter((v) => v !== undefined)
    .sort()
    .at(-1)
  const known = new Set(base)
  for (const name of head) {
    const v = version(name)
    if (known.has(name) || v === undefined || newest === undefined || v > newest) continue
    problems.push(`${name} does not sort after ${newest}, the newest migration on the base`)
  }

  return problems
}
