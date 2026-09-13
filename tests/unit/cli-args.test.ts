import { describe, expect, it } from 'vitest'
import { parseSyncArgs, UsageError } from '../../src/cli/args.ts'

describe('sync CLI arguments', () => {
  it('parses a single-link run with an explicit window', () => {
    expect(
      parseSyncArgs([
        '--link',
        'abc',
        '--from',
        '2026-09-01',
        '--to',
        '2026-09-07',
        '--dry-run',
        '--trigger',
        'backfill',
      ]),
    ).toEqual({
      kind: 'link',
      linkId: 'abc',
      window: { from: '2026-09-01', to: '2026-09-07' },
      dryRun: true,
      trigger: 'backfill',
    })
  })

  it('defaults a single-link run to the source lookback, a real write and the manual trigger', () => {
    expect(parseSyncArgs(['--link', 'abc'])).toEqual({
      kind: 'link',
      linkId: 'abc',
      window: undefined,
      dryRun: false,
      trigger: 'manual',
    })
  })

  it('parses the other modes', () => {
    expect(parseSyncArgs(['--all'])).toEqual({ kind: 'all' })
    expect(parseSyncArgs(['--source', 'zeus', '--list-pixels'])).toEqual({
      kind: 'list-pixels',
      sourceId: 'zeus',
      credential: undefined,
    })
    expect(
      parseSyncArgs(['--source', 'zeus', '--list-pixels', '--credential', 'zeus-main']),
    ).toEqual({ kind: 'list-pixels', sourceId: 'zeus', credential: 'zeus-main' })
    expect(parseSyncArgs(['--check-connection', 'nexd-main'])).toEqual({
      kind: 'check-connection',
      credential: 'nexd-main',
    })
    expect(parseSyncArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseSyncArgs(['-h'])).toEqual({ kind: 'help' })
  })

  it.each<{ name: string; argv: string[]; message: string }>([
    { name: 'no mode', argv: [], message: 'Choose one of' },
    {
      name: 'two modes',
      argv: ['--all', '--link', 'x'],
      message: 'Choose only one of --link, --all',
    },
    {
      name: '--from without --to',
      argv: ['--link', 'x', '--from', '2026-09-01'],
      message: 'both --from and --to',
    },
    {
      name: 'an impossible date',
      argv: ['--link', 'x', '--from', '2026-02-31', '--to', '2026-03-01'],
      message: 'not a calendar date',
    },
    {
      name: 'an inverted window',
      argv: ['--link', 'x', '--from', '2026-09-07', '--to', '2026-09-01'],
      message: 'before start',
    },
    {
      name: 'the cron trigger',
      argv: ['--link', 'x', '--trigger', 'cron'],
      message: 'manual or backfill',
    },
    {
      name: '--dry-run on the nightly pass',
      argv: ['--all', '--dry-run'],
      message: '--dry-run only applies to --link',
    },
    { name: '--list-pixels without a source', argv: ['--list-pixels'], message: 'needs --source' },
    {
      name: '--credential outside --list-pixels',
      argv: ['--check-connection', 'x', '--credential', 'y'],
      message: '--credential only applies to --list-pixels',
    },
    { name: 'an unknown flag', argv: ['--all', '--nope'], message: 'Unknown option' },
    { name: 'a positional argument', argv: ['--all', 'extra'], message: 'positional' },
  ])('rejects $name', ({ argv, message }) => {
    expect(() => parseSyncArgs(argv)).toThrow(UsageError)
    expect(() => parseSyncArgs(argv)).toThrow(message)
  })
})
