import { describe, expect, it } from 'vitest'
import { TRACKED_FIELDS } from '../../src/modules/tracking/event.ts'
import { SEED, sqlstateOf, useTransactionalClient } from './db.ts'

// Migration 0019: analytics.utm_daily, the counts the public page tracker keeps, and the two
// functions a logged-in reader reads them with. Every test runs in a transaction that is rolled
// back; rows are inserted as the service (postgres) and read as `authenticated`, the role a
// signed-in browser has.

const DENIED = '42501' // insufficient_privilege
const INVALID_PARAMETER = '22023'
const CHECK_VIOLATION = '23514'
const NOT_NULL = '23502'
const UNIQUE = '23505'

const BREAKDOWN = 'analytics.utm_breakdown(uuid,text,date,date,text)'
const SOURCE_MEDIUM = 'analytics.utm_source_medium(uuid,date,date,text)'

/** A second campaign of the seed company, so a read can be shown to stay inside its campaign. */
const OTHER = '00000000-0000-4000-8000-000000001901'

interface Breakdown {
  visits: number
  conversions: number
  rows: { value: string; visits: number; conversions: number }[]
}
interface SourceMedium {
  visits: number
  conversions: number
  rows: { utm_source: string; utm_medium: string; visits: number; conversions: number }[]
}

type Row = Partial<Record<(typeof TRACKED_FIELDS)[number], string>> & {
  campaign?: string
  day: string
  language?: string
  overflow?: boolean
  visits?: number
  conversions?: number
}

describe('analytics.utm_daily and its read functions (0019)', () => {
  const { sql } = useTransactionalClient()

  async function insert(...rows: Row[]): Promise<void> {
    for (const row of rows) {
      const fields = TRACKED_FIELDS.filter((field) => row[field] !== undefined)
      const columns = [
        'campaign_id',
        'events_date',
        'language',
        'overflow',
        'visits',
        'conversions',
      ]
      const values: unknown[] = [
        row.campaign ?? SEED.campaignId,
        row.day,
        row.language ?? '',
        row.overflow ?? false,
        row.visits ?? 0,
        row.conversions ?? 0,
      ]
      for (const field of fields) {
        columns.push(field)
        values.push(row[field])
      }
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
      await sql(
        `INSERT INTO analytics.utm_daily (${columns.join(', ')}) VALUES (${placeholders})`,
        values,
      )
    }
  }

  async function addOtherCampaign(): Promise<void> {
    await sql(
      `INSERT INTO app.campaign (id, company_id, name, primary_source)
       VALUES ($1, $2, 'IT0019 Other campaign', 'nexd')`,
      [OTHER, SEED.companyId],
    )
  }

  const asReader = () => sql('SET LOCAL ROLE authenticated')

  async function breakdown(
    dimension: string,
    from: string | null = '2026-11-01',
    to: string | null = '2026-11-30',
    language: string | null = null,
    campaign: string = SEED.campaignId,
  ): Promise<Breakdown> {
    const [row] = await sql<{ result: Breakdown }>(
      `SELECT analytics.utm_breakdown(p_campaign_id => $1, p_dimension => $2, p_from => $3,
                                      p_to => $4, p_language => $5) AS result`,
      [campaign, dimension, from, to, language],
    )
    if (row === undefined) throw new Error('no answer')
    return row.result
  }

  async function sourceMedium(
    from: string | null = '2026-11-01',
    to: string | null = '2026-11-30',
    language: string | null = null,
  ): Promise<SourceMedium> {
    const [row] = await sql<{ result: SourceMedium }>(
      `SELECT analytics.utm_source_medium(p_campaign_id => $1, p_from => $2, p_to => $3,
                                          p_language => $4) AS result`,
      [SEED.campaignId, from, to, language],
    )
    if (row === undefined) throw new Error('no answer')
    return row.result
  }

  describe('the table', () => {
    it('defaults every text field to empty and both counts to 0', async () => {
      await sql(
        `INSERT INTO analytics.utm_daily (campaign_id, events_date) VALUES ($1, '2026-11-24')`,
        [SEED.campaignId],
      )
      const [row] = await sql<Record<string, unknown>>(
        'SELECT * FROM analytics.utm_daily WHERE campaign_id = $1',
        [SEED.campaignId],
      )
      expect(row).toMatchObject({
        source: 'brame',
        language: '',
        overflow: false,
        visits: '0',
        conversions: '0',
        ...Object.fromEntries(TRACKED_FIELDS.map((field) => [field, ''])),
      })
    })

    it('keeps one row per campaign, day, source, language, overflow and combination', async () => {
      await insert({ day: '2026-11-24', utm_source: 'Brame' })
      expect(await sqlstateOf(() => insert({ day: '2026-11-24', utm_source: 'Brame' }))).toBe(
        UNIQUE,
      )
      // Another value in any one of the nine fields is another combination.
      for (const field of TRACKED_FIELDS) {
        await insert({ day: '2026-11-24', utm_source: 'Brame', [field]: `${field}-other` })
      }
      await insert({ day: '2026-11-24', utm_source: 'Brame', language: 'de' })
      await insert({ day: '2026-11-25', utm_source: 'Brame' })
      await insert({ day: '2026-11-24', overflow: true })
      const [count] = await sql<{ n: string }>(
        'SELECT count(*) AS n FROM analytics.utm_daily WHERE campaign_id = $1',
        [SEED.campaignId],
      )
      expect(Number(count?.n)).toBe(1 + TRACKED_FIELDS.length + 3)
    })

    it('never confuses two combinations whose fields join to the same text', async () => {
      await insert({ day: '2026-11-24', utm_source: 'ab', utm_medium: 'c' })
      await insert({ day: '2026-11-24', utm_source: 'a', utm_medium: 'bc' })
      const rows = await sql('SELECT 1 FROM analytics.utm_daily WHERE campaign_id = $1', [
        SEED.campaignId,
      ])
      expect(rows).toHaveLength(2)
    })

    it.each(TRACKED_FIELDS)('refuses a %s over 255 characters, and NULL', async (field) => {
      expect(await sqlstateOf(() => insert({ day: '2026-11-24', [field]: 'x'.repeat(256) }))).toBe(
        CHECK_VIOLATION,
      )
      await insert({ day: '2026-11-24', [field]: '🎉'.repeat(255) }) // characters, not bytes
      expect(
        await sqlstateOf(() =>
          sql(
            `INSERT INTO analytics.utm_daily (campaign_id, events_date, ${field})
             VALUES ($1, '2026-11-25', NULL)`,
            [SEED.campaignId],
          ),
        ),
      ).toBe(NOT_NULL)
    })

    it.each(['visits', 'conversions'])('refuses a negative %s', async (column) => {
      expect(
        await sqlstateOf(() =>
          sql(
            `INSERT INTO analytics.utm_daily (campaign_id, events_date, ${column})
             VALUES ($1, '2026-11-24', -1)`,
            [SEED.campaignId],
          ),
        ),
      ).toBe(CHECK_VIOLATION)
    })

    it('refuses an overflow row that keeps any value: it stands for all of them', async () => {
      expect(
        await sqlstateOf(() => insert({ day: '2026-11-24', overflow: true, utm_source: 'x' })),
      ).toBe(CHECK_VIOLATION)
    })

    it('knows only the brame source', async () => {
      expect(
        await sqlstateOf(() =>
          sql(
            `INSERT INTO analytics.utm_daily (campaign_id, events_date, source)
             VALUES ($1, '2026-11-24', 'zeus')`,
            [SEED.campaignId],
          ),
        ),
      ).toBe(CHECK_VIOLATION)
    })

    it('goes with its campaign', async () => {
      await addOtherCampaign()
      await insert({ campaign: OTHER, day: '2026-11-24', visits: 3 })
      await sql('DELETE FROM app.campaign WHERE id = $1', [OTHER])
      const rows = await sql('SELECT 1 FROM analytics.utm_daily WHERE campaign_id = $1', [OTHER])
      expect(rows).toEqual([])
    })

    it('has row level security, and a reader may select it but never write it', async () => {
      await insert({ day: '2026-11-24', utm_source: 'Brame', visits: 2 })
      await asReader()
      const rows = await sql<{ visits: string }>(
        'SELECT visits FROM analytics.utm_daily WHERE campaign_id = $1',
        [SEED.campaignId],
      )
      expect(rows).toEqual([{ visits: '2' }])
      expect(
        await sqlstateOf(() =>
          sql(
            `INSERT INTO analytics.utm_daily (campaign_id, events_date) VALUES ($1, '2026-11-25')`,
            [SEED.campaignId],
          ),
        ),
      ).toBe(DENIED)
      expect(
        await sqlstateOf(() => sql('UPDATE analytics.utm_daily SET visits = visits + 1')),
      ).toBe(DENIED)
      expect(await sqlstateOf(() => sql('DELETE FROM analytics.utm_daily'))).toBe(DENIED)
    })

    it('is closed to anon', async () => {
      await sql('SET LOCAL ROLE anon')
      expect(await sqlstateOf(() => sql('SELECT 1 FROM analytics.utm_daily'))).toBe(DENIED)
    })
  })

  describe('analytics.utm_breakdown', () => {
    it('groups one field, sorted by visits then value, and leaves out the empty value', async () => {
      await insert(
        {
          day: '2026-11-10',
          utm_source: 'Brame',
          utm_medium: 'display',
          visits: 5,
          conversions: 1,
        },
        { day: '2026-11-11', utm_source: 'Brame', utm_medium: 'social', visits: 2, conversions: 2 },
        { day: '2026-11-10', utm_source: 'Newsletter', visits: 7 },
        { day: '2026-11-10', utm_source: 'Alpha', visits: 7 },
        {
          day: '2026-11-10',
          utm_source: '',
          referrer: 'https://www.google.com/',
          visits: 4,
          conversions: 1,
        },
        { day: '2026-11-10', overflow: true, visits: 3, conversions: 1 },
      )
      await asReader()
      expect(await breakdown('utm_source')).toEqual({
        // Totals count every visit of the period: those without a value and the overflow row too.
        visits: 28,
        conversions: 5,
        rows: [
          { value: 'Alpha', visits: 7, conversions: 0 },
          { value: 'Brame', visits: 7, conversions: 3 },
          { value: 'Newsletter', visits: 7, conversions: 0 },
        ],
      })
      expect((await breakdown('utm_medium')).rows).toEqual([
        { value: 'display', visits: 5, conversions: 1 },
        { value: 'social', visits: 2, conversions: 2 },
      ])
      expect((await breakdown('referrer')).rows).toEqual([
        { value: 'https://www.google.com/', visits: 4, conversions: 1 },
      ])
    })

    it.each(TRACKED_FIELDS)('groups by %s', async (field) => {
      await insert({ day: '2026-11-10', [field]: 'value-a', visits: 2, conversions: 1 })
      await asReader()
      expect((await breakdown(field)).rows).toEqual([
        { value: 'value-a', visits: 2, conversions: 1 },
      ])
    })

    it('covers p_from to p_to, both days included; NULL leaves a side open', async () => {
      await insert(
        { day: '2026-10-31', utm_source: 'a', visits: 1 },
        { day: '2026-11-01', utm_source: 'a', visits: 10 },
        { day: '2026-11-30', utm_source: 'a', visits: 100 },
        { day: '2026-12-01', utm_source: 'a', visits: 1000 },
      )
      await asReader()
      expect((await breakdown('utm_source')).visits).toBe(110)
      expect((await breakdown('utm_source', null, '2026-11-01')).visits).toBe(11)
      expect((await breakdown('utm_source', '2026-11-30', null)).visits).toBe(1100)
      expect((await breakdown('utm_source', null, null)).visits).toBe(1111)
    })

    it('filters by language when one is given; NULL is every language', async () => {
      await insert(
        { day: '2026-11-10', utm_source: 'a', language: 'de', visits: 1 },
        { day: '2026-11-10', utm_source: 'a', language: 'fr', visits: 2 },
        { day: '2026-11-10', utm_source: 'a', visits: 4 },
      )
      await asReader()
      expect((await breakdown('utm_source', null, null, 'de')).visits).toBe(1)
      expect((await breakdown('utm_source', null, null, '')).visits).toBe(4)
      expect((await breakdown('utm_source', null, null, null)).visits).toBe(7)
    })

    it('stays inside its campaign', async () => {
      await addOtherCampaign()
      await insert(
        { day: '2026-11-10', utm_source: 'mine', visits: 1 },
        { campaign: OTHER, day: '2026-11-10', utm_source: 'theirs', visits: 5 },
      )
      await asReader()
      expect(await breakdown('utm_source')).toEqual({
        visits: 1,
        conversions: 0,
        rows: [{ value: 'mine', visits: 1, conversions: 0 }],
      })
    })

    it('answers zeros and no rows for a period without visits', async () => {
      await asReader()
      expect(await breakdown('utm_source')).toEqual({ visits: 0, conversions: 0, rows: [] })
    })

    it.each([
      'UTM_SOURCE',
      'campaign_id',
      'visits',
      "utm_source'; DROP TABLE x; --",
      '',
      'overflow',
    ])(
      'refuses the dimension %j: it is compared as data, never used as a column',
      async (dimension) => {
        await asReader()
        expect(await sqlstateOf(() => breakdown(dimension))).toBe(INVALID_PARAMETER)
      },
    )

    it('refuses a NULL dimension or campaign', async () => {
      await asReader()
      expect(
        await sqlstateOf(() =>
          sql(`SELECT analytics.utm_breakdown($1, NULL, NULL, NULL, NULL)`, [SEED.campaignId]),
        ),
      ).toBe(INVALID_PARAMETER)
      expect(
        await sqlstateOf(() =>
          sql(`SELECT analytics.utm_breakdown(NULL, 'utm_source', NULL, NULL, NULL)`),
        ),
      ).toBe(INVALID_PARAMETER)
    })
  })

  describe('analytics.utm_source_medium', () => {
    it('groups source and medium together, leaving out rows where both are empty', async () => {
      await insert(
        {
          day: '2026-11-10',
          utm_source: 'Brame',
          utm_medium: 'display',
          visits: 5,
          conversions: 1,
        },
        { day: '2026-11-11', utm_source: 'Brame', utm_medium: 'display', utm_term: 'x', visits: 1 },
        { day: '2026-11-10', utm_source: 'Brame', visits: 2 },
        { day: '2026-11-10', utm_medium: 'cpc', visits: 3, conversions: 3 },
        { day: '2026-11-10', referrer: 'https://www.google.com/', visits: 9 },
        { day: '2026-11-10', overflow: true, visits: 4 },
      )
      await asReader()
      expect(await sourceMedium()).toEqual({
        visits: 24,
        conversions: 4,
        rows: [
          { utm_source: 'Brame', utm_medium: 'display', visits: 6, conversions: 1 },
          { utm_source: '', utm_medium: 'cpc', visits: 3, conversions: 3 },
          { utm_source: 'Brame', utm_medium: '', visits: 2, conversions: 0 },
        ],
      })
    })

    it('takes the same period and language as utm_breakdown', async () => {
      await insert(
        { day: '2026-10-31', utm_source: 'a', language: 'de', visits: 1 },
        { day: '2026-11-01', utm_source: 'a', language: 'de', visits: 10 },
        { day: '2026-11-01', utm_source: 'a', language: 'fr', visits: 100 },
      )
      await asReader()
      expect((await sourceMedium('2026-11-01', '2026-11-30', 'de')).visits).toBe(10)
      expect((await sourceMedium(null, null, null)).visits).toBe(111)
    })
  })

  describe('who may call them', () => {
    it.each([BREAKDOWN, SOURCE_MEDIUM])(
      '%s: a reader may, anon and PUBLIC may not; it runs as the caller',
      async (signature) => {
        const [row] = await sql<{
          reader: boolean
          anon: boolean
          everyone: boolean
          definer: boolean
          config: string[]
        }>(
          `SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS reader,
                  has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
                  has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS everyone,
                  p.prosecdef AS definer, p.proconfig AS config
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [signature],
        )
        expect(row).toEqual({
          reader: true,
          anon: false,
          everyone: false,
          definer: false,
          config: ['search_path=""'],
        })
      },
    )
  })
})
