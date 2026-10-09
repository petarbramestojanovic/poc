import { parseArgs } from 'node:util'
import { assertIsoDate, daysInclusive, type DateWindow } from '../core/dates.ts'

// Argument parsing for `npm run sync`, free of I/O so every mode and every misuse is unit tested.
// Exactly one mode per invocation; a flag that only applies to another mode is refused rather
// than silently ignored.

export type SyncCommand =
  | { kind: 'help' }
  | {
      kind: 'link'
      linkId: string
      window: DateWindow | undefined
      dryRun: boolean
      trigger: 'manual' | 'backfill'
    }
  | { kind: 'all' }
  | { kind: 'list-pixels'; sourceId: string; credential: string | undefined }
  | { kind: 'check-connection'; credential: string }

export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export const USAGE = `Usage:
  npm run sync -- --link <link id> [--from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run] [--trigger manual|backfill]
  npm run sync -- --all
  npm run sync -- --source zeus --list-pixels [--credential <name or id>]
  npm run sync -- --check-connection <credential name or id>

  --link              Sync one link. Without --from and --to: the source's lookback ending yesterday.
  --dry-run           Fetch and print what would change per day. Nothing is written.
  --trigger           manual (default; subject to the source's cooldown) or backfill (no cooldown).
  --all               Run the nightly pass now: every eligible link, behind the nightly leader lock.
  --list-pixels       List the pixels the source's token can see, with fires over the last 7 days.
  --check-connection  Probe a credential against its platform and record the result on the row.
`

function parse(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        link: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        'dry-run': { type: 'boolean' },
        trigger: { type: 'string' },
        all: { type: 'boolean' },
        source: { type: 'string' },
        'list-pixels': { type: 'boolean' },
        credential: { type: 'string' },
        'check-connection': { type: 'string' },
      },
    }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

export function parseSyncArgs(argv: readonly string[]): SyncCommand {
  const values = parse(argv)
  if (values.help) return { kind: 'help' }

  const modes: string[] = []
  if (values.link !== undefined) modes.push('--link')
  if (values.all) modes.push('--all')
  if (values['list-pixels']) modes.push('--list-pixels')
  if (values['check-connection'] !== undefined) modes.push('--check-connection')
  const [mode, ...extra] = modes
  if (mode === undefined) {
    throw new UsageError('Choose one of --link, --all, --list-pixels or --check-connection.')
  }
  if (extra.length > 0) throw new UsageError(`Choose only one of ${modes.join(', ')}.`)

  const onlyWith = (flag: string, present: boolean, owner: string): void => {
    if (present && mode !== owner) throw new UsageError(`${flag} only applies to ${owner}.`)
  }
  onlyWith('--from', values.from !== undefined, '--link')
  onlyWith('--to', values.to !== undefined, '--link')
  onlyWith('--dry-run', values['dry-run'] === true, '--link')
  onlyWith('--trigger', values.trigger !== undefined, '--link')
  onlyWith('--source', values.source !== undefined, '--list-pixels')
  onlyWith('--credential', values.credential !== undefined, '--list-pixels')

  if (values.link !== undefined) {
    return {
      kind: 'link',
      linkId: values.link,
      window: parseWindow(values.from, values.to),
      dryRun: values['dry-run'] === true,
      trigger: parseTrigger(values.trigger),
    }
  }
  if (values.all) return { kind: 'all' }
  if (values['list-pixels']) {
    if (values.source === undefined) {
      throw new UsageError('--list-pixels needs --source, for example --source zeus.')
    }
    return { kind: 'list-pixels', sourceId: values.source, credential: values.credential }
  }
  const credential = values['check-connection']
  if (credential === undefined) throw new UsageError('--check-connection needs a credential.')
  return { kind: 'check-connection', credential }
}

function parseWindow(from: string | undefined, to: string | undefined): DateWindow | undefined {
  if (from === undefined && to === undefined) return undefined
  if (from === undefined || to === undefined) {
    throw new UsageError(`Pass both --from and --to, or neither for the source's lookback.`)
  }
  try {
    assertIsoDate(from)
    assertIsoDate(to)
    daysInclusive(from, to)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  return { from, to }
}

function parseTrigger(value: string | undefined): 'manual' | 'backfill' {
  if (value === undefined || value === 'manual') return 'manual'
  if (value === 'backfill') return 'backfill'
  throw new UsageError(`--trigger must be manual or backfill, not ${value}.`)
}
