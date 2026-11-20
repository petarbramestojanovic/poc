import { describe, expect, it } from 'vitest'
import { UsageError } from '../../src/cli/args.ts'
import { INDUSTRIES_USAGE, parseIndustryArgs } from '../../src/cli/industries-commands.ts'

// `npm run industries -- …` arguments, checked before the database is touched. What a backfill
// does to campaigns is tests/integration/cli-industries.test.ts.

describe('parseIndustryArgs', () => {
  it.each([
    [['backfill'], { kind: 'backfill', dryRun: false, reclassify: false }],
    [['backfill', '--dry-run'], { kind: 'backfill', dryRun: true, reclassify: false }],
    [['backfill', '--reclassify'], { kind: 'backfill', dryRun: false, reclassify: true }],
    [
      ['--reclassify', 'backfill', '--dry-run'],
      { kind: 'backfill', dryRun: true, reclassify: true },
    ],
    [['--help'], { kind: 'help' }],
    [['backfill', '-h'], { kind: 'help' }],
  ])('reads %j', (argv, command) => {
    expect(parseIndustryArgs(argv)).toEqual(command)
  })

  it.each([
    [[], 'Choose a command'],
    [['--dry-run'], 'Choose a command'],
    [['reclassify'], 'Choose a command'],
    [['backfill', 'now'], 'Unexpected argument: now'],
    [['backfill', '--dryrun'], 'dryrun'],
    [['backfill', '--dry-run=yes'], 'dry-run'],
    [['backfill', '--campaign', 'x'], 'campaign'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseIndustryArgs(argv)).toThrow(UsageError)
    expect(() => parseIndustryArgs(argv)).toThrow(message)
  })

  it('documents every mode it reads', () => {
    for (const flag of ['backfill', '--dry-run', '--reclassify']) {
      expect(INDUSTRIES_USAGE).toContain(flag)
    }
  })
})
