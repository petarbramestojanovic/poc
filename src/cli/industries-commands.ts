import { parseArgs } from 'node:util'
import { redact } from '../core/http/redact.ts'
import { mapIndustry } from '../modules/industries/map.ts'
import * as repo from '../modules/industries/repo.ts'
import { classifyCampaign, type IndustryDeps } from '../modules/industries/service.ts'
import { UsageError } from './args.ts'

// `npm run industries -- …`: classifies the industry of campaigns that already exist, one at a
// time, through the same service the Salesforce push uses. Parsing and the run are free of process
// I/O, so every mode and misuse is tested.

export type IndustryCommand =
  { kind: 'help' } | { kind: 'backfill'; dryRun: boolean; reclassify: boolean }

export const INDUSTRIES_USAGE = `Usage:
  npm run industries -- backfill [--dry-run] [--reclassify]

  backfill      Classify every campaign whose industry is empty: the keyword table first, then
                the LLM (with OPENROUTER_API_KEY set). One campaign at a time.
  --dry-run     The keyword table only: prints what it would set. No writes, no LLM calls.
  --reclassify  Also redo industries the keyword table or the LLM set, after the table changed.
                A value a person set (PUT /campaigns/:id/industry) is never touched.
`

export function parseIndustryArgs(argv: readonly string[]): IndustryCommand {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        'dry-run': { type: 'boolean' },
        reclassify: { type: 'boolean' },
      },
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals } = parsed
  if (values.help === true) return { kind: 'help' }

  const [mode, ...extra] = positionals
  if (mode !== 'backfill') throw new UsageError('Choose a command: backfill.')
  if (extra.length > 0) throw new UsageError(`Unexpected argument: ${extra.join(' ')}.`)
  return {
    kind: 'backfill',
    dryRun: values['dry-run'] === true,
    reclassify: values.reclassify === true,
  }
}

export interface IndustryCommandDeps {
  industries: IndustryDeps
  signal: AbortSignal
  io: { out: (line: string) => void; err: (line: string) => void }
}

interface Counts {
  set: number
  kept: number
  unresolved: number
}

/** Runs the backfill and returns the exit code: 0 unless the run itself failed. */
export async function executeIndustryCommand(
  command: Extract<IndustryCommand, { kind: 'backfill' }>,
  deps: IndustryCommandDeps,
): Promise<number> {
  const { io, signal } = deps
  const counts: Counts = { set: 0, kept: 0, unresolved: 0 }
  let done = 0
  try {
    const campaigns = await repo.listUnclassified(deps.industries.db, command.reclassify)
    io.out(
      `${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} to classify` +
        (command.dryRun ? ' (dry run: keyword table only, nothing is written)' : '') +
        (!command.dryRun && deps.industries.apiKey === undefined
          ? ' (OPENROUTER_API_KEY is not set: keyword table only)'
          : ''),
    )
    for (const campaign of campaigns) {
      signal.throwIfAborted()
      io.out(
        command.dryRun
          ? dryRunLine(campaign, counts)
          : await classifyLine(deps, campaign, command.reclassify, counts),
      )
      done += 1
    }
  } catch (error) {
    if (signal.aborted) {
      io.err(`Stopped after ${done} campaigns. Run it again to go on: it picks up what is left.`)
    } else {
      const message = error instanceof Error ? error.message : String(error)
      io.err(`Failed after ${done} campaigns: ${redact(message)}`)
    }
    io.out(summary(counts, command.dryRun))
    return 1
  }
  io.out(summary(counts, command.dryRun))
  return 0
}

/** What the keyword table alone would do; the LLM is not asked. */
function dryRunLine(campaign: repo.BackfillCandidate, counts: Counts): string {
  const mapped = mapIndustry(campaign.companyName, campaign.name)
  if (mapped === null) {
    counts.unresolved += 1
    return line(campaign, campaign.industry, 'LLM (not run)', null)
  }
  if (mapped === campaign.industry && campaign.industrySource === 'map') {
    counts.kept += 1
    return line(campaign, campaign.industry, mapped, 'kept')
  }
  counts.set += 1
  return line(campaign, campaign.industry, mapped, 'map')
}

async function classifyLine(
  deps: IndustryCommandDeps,
  campaign: repo.BackfillCandidate,
  reclassify: boolean,
  counts: Counts,
): Promise<string> {
  const result = await classifyCampaign(
    { ...deps.industries, signal: deps.signal },
    campaign.id,
    reclassify ? { reclassify } : {},
  )
  counts[result.outcome] += 1
  return line(
    campaign,
    campaign.industry,
    result.industry,
    result.outcome === 'set' ? result.via : result.outcome,
  )
}

/** `<external id>  <old> → <new>  (<via>)`: no campaign or company name. */
function line(
  campaign: repo.BackfillCandidate,
  before: string | null,
  after: string | null,
  via: string | null,
): string {
  const id = campaign.externalId ?? campaign.id
  return `${id}  ${before ?? '—'} → ${after ?? '—'}${via === null ? '' : `  (${via})`}`
}

function summary(counts: Counts, dryRun: boolean): string {
  const prefix = dryRun ? 'Dry run, nothing written: would set' : 'set'
  return `${prefix} ${counts.set}, kept ${counts.kept}, unresolved ${counts.unresolved}`
}
