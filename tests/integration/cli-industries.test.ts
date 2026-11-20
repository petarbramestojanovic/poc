import { pino } from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { executeIndustryCommand } from '../../src/cli/industries-commands.ts'
import type { Db } from '../../src/core/db.ts'
import { createHttpClient } from '../../src/core/http/HttpClient.ts'
import type { IndustryDeps } from '../../src/modules/industries/service.ts'
import { useTransactionalClient } from './db.ts'

// `npm run industries -- backfill` against the real schema with a scripted LLM. Every test runs
// in one transaction that is rolled back, so the backfill may walk over every campaign in the
// database, the seed's among them, and leave each as it was. The campaigns of this file belong to
// the company 'IT CliInd Agency'; their external ids start with 'it-cliind-'.

/** Our campaigns: the name the keyword table reads, and what each has before the run. */
const CAMPAIGNS = {
  lidl: { name: 'IT CliInd Lidl Punkte', industry: null, source: null },
  mystery: { name: 'IT CliInd Mystery Launch', industry: null, source: null },
  tchibo: { name: 'IT CliInd Tchibo Kaffee', industry: 'Retail', source: 'map' },
  // The table says FMCG / CPG for Stiegl now; 'Retail' is what an older table said.
  stiegl: { name: 'IT CliInd Stiegl Bier', industry: 'Retail', source: 'map' },
  penny: { name: 'IT CliInd Penny Promo', industry: 'Tech-Telco', source: 'manual' },
  guessed: { name: 'IT CliInd Unknown Brand', industry: 'Entertainment', source: 'llm' },
} as const
type Key = keyof typeof CAMPAIGNS

describe('npm run industries -- backfill', () => {
  const { sql } = useTransactionalClient()
  let prompts: number
  let out: string[]

  beforeEach(async () => {
    prompts = 0
    out = []
    const [company] = await sql<{ id: string }>(
      `INSERT INTO app.company (name) VALUES ('IT CliInd Agency') RETURNING id`,
    )
    // One at a time: the client runs each statement in its own savepoint.
    for (const [key, c] of Object.entries(CAMPAIGNS) as [Key, (typeof CAMPAIGNS)[Key]][]) {
      await sql(
        `INSERT INTO app.campaign
           (company_id, name, primary_source, external_system, external_id, industry, industry_source)
         VALUES ($1, $2, 'zeus', 'salesforce', $3, $4, $5)`,
        [company?.id, c.name, `it-cliind-${key}`, c.industry, c.source],
      )
    }
  })

  /** The backfill as `npm run industries` runs it, inside this test's transaction. */
  async function backfill(flags: { dryRun?: boolean; reclassify?: boolean } = {}) {
    const http = createHttpClient({
      log: pino({ level: 'silent' }),
      maxRetries: 0,
      fetch: async () => {
        prompts += 1
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Retail' } }] }), {
          status: 200,
        })
      },
    })
    const industries: IndustryDeps = {
      // Everything the backfill does is a single statement, so this test's client is enough.
      db: { query: sql } as unknown as Db,
      http,
      log: pino({ level: 'silent' }),
      apiKey: 'sk-or-v1-it-cliind-0123456789abcdef',
    }
    return executeIndustryCommand(
      { kind: 'backfill', dryRun: flags.dryRun ?? false, reclassify: flags.reclassify ?? false },
      {
        industries,
        signal: new AbortController().signal,
        io: { out: (line) => out.push(line), err: (line) => out.push(`ERR ${line}`) },
      },
    )
  }

  const stored = async () => {
    const rows = await sql<{ external_id: string; industry: string | null; source: string | null }>(
      `SELECT external_id, industry, industry_source AS source FROM app.campaign
        WHERE external_id LIKE 'it-cliind-%'`,
    )
    return Object.fromEntries(
      rows.map((row) => [row.external_id.slice('it-cliind-'.length), [row.industry, row.source]]),
    )
  }
  const lineOf = (key: Key) => out.find((line) => line.startsWith(`it-cliind-${key} `))

  it('in a dry run, prints what the keyword table would set and writes nothing', async () => {
    const before = await stored()

    expect(await backfill({ dryRun: true })).toBe(0)

    expect(await stored()).toEqual(before)
    expect(prompts).toBe(0)
    expect(lineOf('lidl')).toBe('it-cliind-lidl  — → Food Retail  (map)')
    expect(lineOf('mystery')).toBe('it-cliind-mystery  — → LLM (not run)')
    // Only empty ones are listed without --reclassify.
    expect(lineOf('tchibo')).toBeUndefined()
    expect(out.at(-1)).toMatch(/^Dry run, nothing written: would set \d+, kept 0, unresolved \d+$/)
  })

  it('fills only the empty ones: the keyword table, then the LLM', async () => {
    expect(await backfill()).toBe(0)

    expect(await stored()).toEqual({
      lidl: ['Food Retail', 'map'],
      mystery: ['Retail', 'llm'],
      tchibo: ['Retail', 'map'],
      stiegl: ['Retail', 'map'], // set already: left alone without --reclassify
      penny: ['Tech-Telco', 'manual'],
      guessed: ['Entertainment', 'llm'],
    })
    expect(lineOf('lidl')).toBe('it-cliind-lidl  — → Food Retail  (map)')
    expect(lineOf('mystery')).toBe('it-cliind-mystery  — → Retail  (llm)')
    expect(lineOf('stiegl')).toBeUndefined()
    expect(out.at(-1)).toMatch(/^set \d+, kept 0, unresolved 0$/)
  })

  it('with --reclassify, redoes what the table or the LLM set and never what a person set', async () => {
    expect(await backfill({ reclassify: true })).toBe(0)

    expect(await stored()).toEqual({
      lidl: ['Food Retail', 'map'],
      mystery: ['Retail', 'llm'],
      tchibo: ['Retail', 'map'], // the same answer: kept, nothing written
      stiegl: ['FMCG / CPG', 'map'], // what the table says now
      penny: ['Tech-Telco', 'manual'], // a person's: never listed, never touched
      guessed: ['Retail', 'llm'], // the LLM was asked again
    })
    expect(lineOf('stiegl')).toBe('it-cliind-stiegl  Retail → FMCG / CPG  (map)')
    expect(lineOf('tchibo')).toBe('it-cliind-tchibo  Retail → Retail  (kept)')
    expect(lineOf('penny')).toBeUndefined()
  })

  it('with --reclassify --dry-run, shows the keyword table change and writes nothing', async () => {
    const before = await stored()

    expect(await backfill({ dryRun: true, reclassify: true })).toBe(0)

    expect(await stored()).toEqual(before)
    expect(prompts).toBe(0)
    expect(lineOf('stiegl')).toBe('it-cliind-stiegl  Retail → FMCG / CPG  (map)')
    expect(lineOf('tchibo')).toBe('it-cliind-tchibo  Retail → Retail  (kept)')
    expect(lineOf('guessed')).toBe('it-cliind-guessed  Entertainment → LLM (not run)')
    expect(lineOf('penny')).toBeUndefined()
  })

  it('stops between campaigns on Ctrl+C and says how far it got', async () => {
    const controller = new AbortController()
    controller.abort(new Error('SIGINT'))
    const code = await executeIndustryCommand(
      { kind: 'backfill', dryRun: false, reclassify: false },
      {
        industries: {
          db: { query: sql } as unknown as Db,
          http: createHttpClient({ log: pino({ level: 'silent' }) }),
          log: pino({ level: 'silent' }),
        },
        signal: controller.signal,
        io: { out: (line) => out.push(line), err: (line) => out.push(`ERR ${line}`) },
      },
    )

    expect(code).toBe(1)
    expect(out).toContain(
      'ERR Stopped after 0 campaigns. Run it again to go on: it picks up what is left.',
    )
    expect(await stored()).toMatchObject({ lidl: [null, null] })
  })
})
