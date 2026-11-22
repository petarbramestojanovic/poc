import { beforeEach, describe, expect, it } from 'vitest'
import { at } from '../helpers.ts'
import { sqlstateOf, useTransactionalClient } from './db.ts'

// Migrations 0017 and 0018: the two functions the frontend lists campaigns with. They are
// SECURITY DEFINER, because a reader has no grant on app.company and gets a company's name here and
// nowhere else. Since 0018 a row also carries the campaign's numbers (from its primary source only),
// its delivery against the planned impressions, and the deal's country and owner.
//
// Every test runs in a transaction that is rolled back. It first removes the campaigns that are
// there, so the fixture below is the whole list: `total`, the defaults and the empty answer are
// then exact, whatever the local database holds. Every call is made as `authenticated`, the role a
// signed-in browser has.
//
// The fixture is built so that the rules can be broken: names and managers mix upper and lower
// case, every sort column has its own order (none is the default, newest first), prices sort
// differently as text, and every nullable column is null somewhere.

const DENIED = '42501' // insufficient_privilege

const LIST_SIGNATURE =
  'analytics.list_campaigns(text,text,uuid[],text[],text[],text[],date,date,text,boolean,integer,integer,date,date,text[],text[])'
const OPTIONS_SIGNATURE = 'analytics.list_campaign_filter_options()'

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-0000000017${String(n).padStart(2, '0')}`

const ALPHA = uuid(1)
const BETA = uuid(2)
/** A company without a campaign, until a test gives it some. */
const GAMMA = uuid(3)

const C1 = uuid(11)
const C2 = uuid(12)
const C3 = uuid(13)
const C4 = uuid(14)
const C5 = uuid(15)

const NEXD_CREDENTIAL = '00000000-0000-4000-8000-000000000011'
const ZEUS_CREDENTIAL = '00000000-0000-4000-8000-000000000012'

/** The keys of 0017: the campaign's record. */
const RECORD_KEYS = [
  'company_id',
  'company_name',
  'created_at',
  'currency',
  'ends_on',
  'id',
  'industry',
  'industry_source',
  'languages',
  'manager_name',
  'name',
  'price',
  'primary_source',
  'sources',
  'starts_on',
  'status',
  'updated_at',
]
/** The keys 0018 adds: two of the deal, and the numbers. */
const DEAL_KEYS = ['country', 'owner_name']
const NUMBER_KEYS = [
  'impressions',
  'viewable_impressions',
  'engagements',
  'clicks',
  'engagement_rate',
  'ctr',
  'viewability',
  'desktop_impressions',
  'mobile_impressions',
  'desktop_share',
  'mobile_share',
  'planned_impressions',
  'delivered_impressions',
  'delivery',
]
const ROW_KEYS = [...RECORD_KEYS, ...DEAL_KEYS, ...NUMBER_KEYS].sort()
/** A campaign without a number: no analytics row, no planned impressions. */
const NO_NUMBERS = Object.fromEntries(NUMBER_KEYS.map((key) => [key, null]))

type CampaignRow = Record<string, unknown> & { id: string }
interface Page {
  total: number
  rows: CampaignRow[]
}
interface FilterOptions {
  companies: { id: string; name: string }[]
  industries: string[]
  managers: string[]
  sources: string[]
  countries: string[]
  owners: string[]
}

/** The arguments as the frontend names them; it sends only the ones that are set. */
type ListArgs = Partial<{
  p_search: string | null
  p_status: string | null
  p_company_ids: string[] | null
  p_industries: string[] | null
  p_managers: string[] | null
  p_sources: string[] | null
  p_flight_from: string | null
  p_flight_to: string | null
  p_sort: string | null
  p_sort_desc: boolean | null
  p_limit: number | null
  p_offset: number | null
  p_from: string | null
  p_to: string | null
  p_countries: string[] | null
  p_owners: string[] | null
}>

describe('the campaign list functions (0017, 0018)', () => {
  const { sql } = useTransactionalClient()

  const asReader = () => sql('SET LOCAL ROLE authenticated')
  const asAnon = () => sql('SET LOCAL ROLE anon')
  const asService = () => sql('RESET ROLE')

  const list = async (args: ListArgs = {}): Promise<Page> => {
    const named = Object.keys(args).map((name, index) => `${name} => $${index + 1}`)
    const rows = await sql<{ page: Page }>(
      `SELECT analytics.list_campaigns(${named.join(', ')}) AS page`,
      Object.values(args),
    )
    return at(rows).page
  }
  const ids = async (args: ListArgs = {}): Promise<string[]> =>
    (await list(args)).rows.map((row) => row.id)
  const idSet = async (args: ListArgs = {}): Promise<string[]> => (await ids(args)).sort()

  const options = async (): Promise<FilterOptions> =>
    at(
      await sql<{ options: FilterOptions }>(
        'SELECT analytics.list_campaign_filter_options() AS options',
      ),
    ).options

  /** `count` campaigns of GAMMA that tie on every sort column and on created_at: only the id differs. */
  const addTiedCampaigns = async (count: number): Promise<string[]> => {
    await asService()
    const rows = await sql<{ id: string }>(
      `INSERT INTO app.campaign (company_id, name, primary_source, created_at, updated_at)
       SELECT $1, 'clf tied', 'nexd', '2026-01-10T00:00:00Z', '2026-01-10T00:00:00Z'
         FROM generate_series(1, $2::int)
       RETURNING id`,
      [GAMMA, count],
    )
    await asReader()
    return rows.map((row) => row.id).sort()
  }

  beforeEach(async () => {
    await sql('DELETE FROM app.campaign')
    await sql(
      `INSERT INTO app.company (id, name) VALUES
         ($1, 'clf Alpha Markets'), ($2, 'CLF beta Foods'), ($3, 'clf Gamma Idle')`,
      [ALPHA, BETA, GAMMA],
    )
    await sql(
      `INSERT INTO app.campaign
         (id, company_id, name, status, primary_source, languages, starts_on, ends_on,
          price, currency, manager_external_id, manager_name, industry, industry_source,
          created_at, updated_at)
       VALUES
         ($1, $6, 'clf apple Spring 100%', 'active',   'nexd', '{de,fr}', '2026-03-01', '2026-03-31',
          12.5,     'CHF', 'm-1', 'Mia Keller', 'Retail',     'map',
          '2026-01-01T10:00:00Z', '2026-02-03T10:00:00Z'),
         ($2, $6, 'CLF Banana summer',     'draft',    'zeus', '{de}',    '2026-06-01', NULL,
          NULL,     NULL,  'm-2', 'jonas Frei', NULL,         NULL,
          '2026-01-02T10:00:00Z', '2026-02-05T10:00:00Z'),
         ($3, $7, 'clf cherry_autumn',     'archived', 'nexd', '{}',      '2026-09-01', '2026-09-30',
          3.123456, 'EUR', NULL,  NULL,         'Automotive', 'llm',
          '2026-01-03T10:00:00Z', '2026-02-01T10:00:00Z'),
         ($4, $7, 'CLF Date winter',       'active',   'nexd', '{de}',    NULL,         NULL,
          20,       'CHF', 'm-1', 'Mia Keller', 'Retail',     'manual',
          '2026-01-04T10:00:00Z', '2026-02-04T10:00:00Z'),
         ($5, $6, 'clf elder 100x',        'active',   'zeus', '{de}',    NULL,         '2026-04-15',
          NULL,     NULL,  NULL,  NULL,         NULL,         NULL,
          '2026-01-05T10:00:00Z', '2026-02-02T10:00:00Z')`,
      [C1, C2, C3, C4, C5, ALPHA, BETA],
    )
    // C1 is on both platforms, C3 has two links to the same one, C4 has none.
    await sql(
      `INSERT INTO external.campaign_link (campaign_id, source_id, credential_id, language) VALUES
         ($1, 'zeus', $5, 'de'), ($1, 'nexd', $4, 'de'),
         ($2, 'zeus', $5, 'de'),
         ($3, 'nexd', $4, 'de'), ($3, 'nexd', $4, 'fr'),
         ($6, 'zeus', $5, 'de')`,
      [C1, C2, C3, NEXD_CREDENTIAL, ZEUS_CREDENTIAL, C5],
    )
    await asReader()
  })

  describe('access', () => {
    it('lets a logged-in reader call both', async () => {
      expect((await list()).total).toBe(5)
      expect((await options()).companies).toHaveLength(2)
    })

    it('refuses the browser key before a login', async () => {
      await asAnon()
      expect(await sqlstateOf(() => list())).toBe(DENIED)
      expect(await sqlstateOf(() => options())).toBe(DENIED)
    })

    it.each([LIST_SIGNATURE, OPTIONS_SIGNATURE])(
      'grants EXECUTE on %s to authenticated only, not to PUBLIC',
      async (signature) => {
        const [row] = await sql<{ reader: boolean; anon: boolean; everyone: boolean }>(
          `SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS reader,
                  has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
                  has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS everyone`,
          [signature],
        )
        expect(row).toEqual({ reader: true, anon: false, everyone: false })
      },
    )

    it.each([LIST_SIGNATURE, OPTIONS_SIGNATURE])(
      'runs %s as its owner with an empty search path, so no caller can put a table in its way',
      async (signature) => {
        const [row] = await sql<{ definer: boolean; config: string[] | null }>(
          `SELECT prosecdef AS definer, proconfig AS config
             FROM pg_proc WHERE oid = $1::regprocedure`,
          [signature],
        )
        expect(row).toEqual({ definer: true, config: ['search_path=""'] })
      },
    )

    it('still gives a reader nothing of app.company itself', async () => {
      expect(await sqlstateOf(() => sql('SELECT name FROM app.company'))).toBe(DENIED)
      expect(await sqlstateOf(() => sql('SELECT count(*) FROM app.company'))).toBe(DENIED)
    })

    it('returns of app.campaign only columns a reader may select anyway, but for country and owner', async () => {
      const rows = await sql<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'campaign'
            AND has_column_privilege('authenticated', 'app.campaign', column_name, 'SELECT')`,
      )
      const readable = new Set(rows.map((row) => row.column_name))
      // The company's name and the platforms come from other tables.
      const fromCampaign = RECORD_KEYS.filter((key) => key !== 'company_name' && key !== 'sources')
      expect(fromCampaign).toHaveLength(15)
      for (const key of fromCampaign) expect(readable.has(key), key).toBe(true)
      // 0018 lets these two of the deal out through the functions, approved; their grant stays closed.
      for (const key of DEAL_KEYS) expect(readable.has(key), key).toBe(false)
    })

    it('is one function, so a call by argument names is never ambiguous', async () => {
      const [row] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc
          WHERE pronamespace = 'analytics'::regnamespace
            AND proname IN ('list_campaigns', 'list_campaign_filter_options')`,
      )
      expect(row?.n).toBe(2)
    })
  })

  describe('a row', () => {
    it('has the campaign, its company’s name and its platforms', async () => {
      const page = await list({ p_search: 'apple' })
      expect(page.total).toBe(1)
      const row = at(page.rows)
      expect({
        ...row,
        created_at: new Date(row.created_at as string).toISOString(),
        updated_at: new Date(row.updated_at as string).toISOString(),
      }).toEqual({
        id: C1,
        company_id: ALPHA,
        company_name: 'clf Alpha Markets',
        name: 'clf apple Spring 100%',
        status: 'active',
        primary_source: 'nexd',
        sources: ['nexd', 'zeus'],
        languages: ['de', 'fr'],
        starts_on: '2026-03-01',
        ends_on: '2026-03-31',
        price: 12.5,
        currency: 'CHF',
        manager_name: 'Mia Keller',
        industry: 'Retail',
        industry_source: 'map',
        created_at: '2026-01-01T10:00:00.000Z',
        updated_at: '2026-02-03T10:00:00.000Z',
        country: null,
        owner_name: null,
        ...NO_NUMBERS,
      })
      // ISO 8601 with an offset, as PostgREST prints a timestamptz.
      expect(row.created_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
      )
    })

    it('has exactly the listed keys, and nothing the deal keeps closed', async () => {
      await asService()
      await sql(
        `UPDATE app.campaign
            SET amount = 98765.43, amount_currency = 'CHF', deal_type = 'Closed Deal Type',
                country = 'Closedland', creative_types = '{Closed Creative}',
                owner_name = 'Olga Owner', external_modified_at = '2026-02-09T00:00:00Z',
                external_system = 'salesforce', external_id = '006CLOSEDREF000001',
                legacy_campaign_id = 'clf-closed-legacy'
          WHERE id = $1`,
        [C1],
      )
      // A currency no other column has, so that its absence says something.
      await sql(`UPDATE app.campaign SET amount = 1, amount_currency = 'XAU' WHERE id = $1`, [C3])
      await asReader()

      for (const args of [{}, { p_sort: 'planned_impressions' }, { p_sort: 'delivery' }]) {
        const page = await list(args)
        for (const row of page.rows) expect(Object.keys(row).sort()).toEqual(ROW_KEYS)
        const text = JSON.stringify(page)
        for (const closed of [
          '98765.43',
          'XAU',
          'Closed Deal Type',
          'Closed Creative',
          '2026-02-09',
          'm-1',
          '006CLOSEDREF000001',
          'clf-closed-legacy',
        ]) {
          expect(text, closed).not.toContain(closed)
        }
        // Since 0018 the country and the owner leave, approved; the deal's amount only as the
        // planned impressions it gives (98765.43 CHF at 12.5 CHF a thousand).
        expect(page.rows.find((row) => row.id === C1)).toMatchObject({
          country: 'Closedland',
          owner_name: 'Olga Owner',
          planned_impressions: 7901234,
        })
      }
    })

    it('keeps a price exact, and null with its currency when it is not known: never 0', async () => {
      const rows = await sql<{ id: string; price: string; currency: string }>(
        `SELECT row->>'id' AS id, row->'price' #>> '{}' AS price, row->>'currency' AS currency
           FROM jsonb_array_elements(analytics.list_campaigns()->'rows') AS row`,
      )
      const byId = new Map(rows.map((row) => [row.id, row]))
      expect(Number(byId.get(C3)?.price)).toBe(3.123456)
      expect(byId.get(C3)?.price).toMatch(/^3\.123456$/)
      expect(byId.get(C3)?.currency).toBe('EUR')

      const page = await list()
      const unpriced = page.rows.filter((row) => row.id === C2 || row.id === C5)
      expect(unpriced).toHaveLength(2)
      for (const row of unpriced) {
        expect(row.price).toBeNull()
        expect(row.currency).toBeNull()
      }
    })

    it('lists each platform once, sorted, and none as an empty list', async () => {
      const sources = new Map((await list()).rows.map((row) => [row.id, row.sources]))
      expect(sources.get(C1)).toEqual(['nexd', 'zeus'])
      expect(sources.get(C3)).toEqual(['nexd'])
      expect(sources.get(C4)).toEqual([])
    })

    it('keeps what is not known null', async () => {
      const row = at((await list({ p_search: 'elder' })).rows)
      expect(row).toMatchObject({
        starts_on: null,
        ends_on: '2026-04-15',
        manager_name: null,
        industry: null,
        industry_source: null,
      })
    })
  })

  describe('defaults', () => {
    it('with no arguments gives the newest ten and the full total', async () => {
      const tied = await addTiedCampaigns(8)
      const page = await list()
      expect(page.total).toBe(13)
      // The eight tied ones are the newest (10 Jan), by id; then the two newest of the fixture.
      expect(page.rows.map((row) => row.id)).toEqual([...tied, C5, C4])
    })

    it('takes an explicit null for the default too', async () => {
      await addTiedCampaigns(8)
      const page = await list({
        p_search: null,
        p_status: null,
        p_company_ids: null,
        p_industries: null,
        p_managers: null,
        p_sources: null,
        p_flight_from: null,
        p_flight_to: null,
        p_sort: null,
        p_sort_desc: null,
        p_limit: null,
        p_offset: null,
      })
      expect(page.total).toBe(13)
      expect(page.rows).toHaveLength(10)
      expect(page.rows.map((row) => row.id)).toEqual((await list()).rows.map((row) => row.id))
    })
  })

  describe('filters', () => {
    it.each([
      ['active', [C1, C4, C5]],
      ['draft', [C2]],
      ['archived', [C3]],
      ['paused', []],
    ])('by status %s', async (status, expected) => {
      expect(await idSet({ p_status: status })).toEqual(expected)
    })

    it('by company, any of the listed', async () => {
      expect(await idSet({ p_company_ids: [BETA] })).toEqual([C3, C4])
      expect(await idSet({ p_company_ids: [BETA, ALPHA] })).toEqual([C1, C2, C3, C4, C5])
      expect(await idSet({ p_company_ids: [GAMMA] })).toEqual([])
    })

    it('by industry, any of the listed', async () => {
      expect(await idSet({ p_industries: ['Retail'] })).toEqual([C1, C4])
      expect(await idSet({ p_industries: ['Automotive', 'Retail'] })).toEqual([C1, C3, C4])
      expect(await idSet({ p_industries: ['Finance & Insurance'] })).toEqual([])
    })

    it('by manager name, as the filter options spell it', async () => {
      expect(await idSet({ p_managers: ['Mia Keller'] })).toEqual([C1, C4])
      expect(await idSet({ p_managers: ['jonas Frei', 'Mia Keller'] })).toEqual([C1, C2, C4])
      expect(await idSet({ p_managers: ['mia keller'] })).toEqual([])
    })

    it('by platform: the campaigns linked to it, whatever their headline source', async () => {
      expect(await idSet({ p_sources: ['zeus'] })).toEqual([C1, C2, C5])
      // C4's headline is nexd, but it has no link.
      expect(await idSet({ p_sources: ['nexd'] })).toEqual([C1, C3])
      expect(await idSet({ p_sources: ['nexd', 'zeus'] })).toEqual([C1, C2, C3, C5])
      expect(await idSet({ p_sources: ['brame'] })).toEqual([])
    })

    it('combines filters with AND', async () => {
      expect(await idSet({ p_status: 'active', p_sources: ['zeus'] })).toEqual([C1, C5])
      expect(
        await idSet({ p_status: 'active', p_sources: ['zeus'], p_industries: ['Retail'] }),
      ).toEqual([C1])
      const none = await list({ p_status: 'active', p_sources: ['zeus'], p_company_ids: [BETA] })
      expect(none).toEqual({ total: 0, rows: [] })
    })

    it('counts what matches, not what is on the page', async () => {
      const page = await list({ p_status: 'active', p_limit: 2 })
      expect(page.total).toBe(3)
      expect(page.rows).toHaveLength(2)
    })

    it('takes an empty list for "none of them": only null means no restriction', async () => {
      expect(await list({ p_company_ids: [] })).toEqual({ total: 0, rows: [] })
      expect(await list({ p_sources: [] })).toEqual({ total: 0, rows: [] })
    })
  })

  describe('search', () => {
    it.each([
      ['a word of the campaign name', 'cherry', [C3]],
      ['a word of the company name', 'beta', [C3, C4]],
      ['a word of the manager name', 'keller', [C1, C4]],
      ['part of a word', 'ana', [C2]],
      ['any case', 'BANANA', [C2]],
      ['words in different fields, in any order', 'KELLER alpha Apple', [C1]],
      ['every word, not any of them', 'keller beta', [C4]],
      ['a word nothing has', 'keller zebra', []],
      ['words around spaces, tabs and line breaks', '  mia \t\n beta  ', [C4]],
    ])('finds %s', async (_what, search, expected) => {
      expect(await idSet({ p_search: search })).toEqual(expected)
    })

    it('never matches a word across two fields', async () => {
      // "summer" ends C2's name and "clf" starts its company's.
      expect(await idSet({ p_search: 'summerclf' })).toEqual([])
      expect(await idSet({ p_search: 'summer clf' })).toEqual([C2])
    })

    it('takes % and _ as the characters they are', async () => {
      expect(await idSet({ p_search: '100%' })).toEqual([C1])
      expect(await idSet({ p_search: '_' })).toEqual([C3])
      expect(await idSet({ p_search: '%' })).toEqual([C1])
      expect(await idSet({ p_search: 'c%y' })).toEqual([])
      expect(await idSet({ p_search: 'cherry\\' })).toEqual([])
    })

    it.each([[''], ['   '], [' \t\n ']])('restricts nothing with %j', async (search) => {
      expect((await list({ p_search: search })).total).toBe(5)
    })
  })

  describe('flight window', () => {
    // C1 1–31 Mar · C2 from 1 Jun, open · C3 1–30 Sep · C4 no dates · C5 until 15 Apr, start unknown
    it.each<[string, ListArgs, string[]]>([
      ['from the last day of a flight', { p_flight_from: '2026-03-31' }, [C1, C2, C3, C5]],
      ['from the day after it', { p_flight_from: '2026-04-01' }, [C2, C3, C5]],
      ['to the first day of a flight', { p_flight_to: '2026-03-01' }, [C1]],
      ['to the day before it', { p_flight_to: '2026-02-28' }, []],
      [
        'a window inside an open flight',
        { p_flight_from: '2026-07-01', p_flight_to: '2026-08-31' },
        [C2],
      ],
      [
        'a window that touches both edges',
        { p_flight_from: '2026-03-31', p_flight_to: '2026-06-01' },
        [C1, C2],
      ],
      [
        'a window between two flights',
        { p_flight_from: '2026-04-16', p_flight_to: '2026-05-31' },
        [],
      ],
      ['after every end: only the open one', { p_flight_from: '2026-10-01' }, [C2]],
    ])('%s', async (_what, args, expected) => {
      expect(await idSet(args)).toEqual(expected)
    })

    it('leaves out a campaign without dates as soon as a window is set', async () => {
      expect(await idSet()).toContain(C4)
      expect(await idSet({ p_flight_from: '2000-01-01' })).not.toContain(C4)
      expect(await idSet({ p_flight_to: '2100-01-01' })).not.toContain(C4)
      expect(await idSet({ p_flight_from: '2000-01-01', p_flight_to: '2100-01-01' })).not.toContain(
        C4,
      )
    })

    it('needs a start to be on or before the window’s end: an unknown start is not', async () => {
      expect(await idSet({ p_flight_from: '2026-04-01' })).toContain(C5)
      expect(await idSet({ p_flight_to: '2100-01-01' })).not.toContain(C5)
    })
  })

  describe('sort', () => {
    const NEWEST_FIRST = [C5, C4, C3, C2, C1]

    // Ties go newest first in both directions, and nulls come last in both.
    it.each<[string, string[], string[]]>([
      ['name', [C1, C2, C3, C4, C5], [C5, C4, C3, C2, C1]],
      ['company_name', [C5, C2, C1, C4, C3], [C4, C3, C5, C2, C1]],
      ['status', [C2, C5, C4, C1, C3], [C3, C5, C4, C1, C2]],
      ['industry', [C3, C4, C1, C5, C2], [C4, C1, C3, C5, C2]],
      ['starts_on', [C1, C2, C3, C5, C4], [C3, C2, C1, C5, C4]],
      ['ends_on', [C1, C5, C3, C4, C2], [C3, C5, C1, C4, C2]],
      ['primary_source', [C4, C3, C1, C5, C2], [C5, C2, C4, C3, C1]],
      ['price', [C3, C1, C4, C5, C2], [C4, C1, C3, C5, C2]],
      ['manager_name', [C2, C4, C1, C5, C3], [C4, C1, C2, C5, C3]],
      ['created_at', [C1, C2, C3, C4, C5], [C5, C4, C3, C2, C1]],
      ['updated_at', [C3, C5, C1, C4, C2], [C2, C4, C1, C5, C3]],
    ])('by %s, up and down', async (column, ascending, descending) => {
      expect(await ids({ p_sort: column }), 'ascending by default').toEqual(ascending)
      expect(await ids({ p_sort: column, p_sort_desc: false }), 'ascending').toEqual(ascending)
      expect(await ids({ p_sort: column, p_sort_desc: true }), 'descending').toEqual(descending)
    })

    it('puts nulls last in both directions', async () => {
      for (const descending of [false, true]) {
        const rows = (await list({ p_sort: 'price', p_sort_desc: descending })).rows
        expect(rows.map((row) => row.price === null)).toEqual([false, false, false, true, true])
      }
    })

    it('sorts text without regard to case', async () => {
      const names = (await list({ p_sort: 'name' })).rows.map((row) => row.name)
      expect(names).toEqual([
        'clf apple Spring 100%',
        'CLF Banana summer',
        'clf cherry_autumn',
        'CLF Date winter',
        'clf elder 100x',
      ])
      const managers = (await list({ p_sort: 'manager_name' })).rows.map((row) => row.manager_name)
      expect(managers).toEqual(['jonas Frei', 'Mia Keller', 'Mia Keller', null, null])
    })

    it('sorts status as a lifecycle, not as a word', async () => {
      const statuses = (await list({ p_sort: 'status' })).rows.map((row) => row.status)
      expect(statuses).toEqual(['draft', 'active', 'active', 'active', 'archived'])
    })

    it('sorts a price as a number, not as text', async () => {
      const prices = (await list({ p_sort: 'price' })).rows.map((row) => row.price)
      expect(prices).toEqual([3.123456, 12.5, 20, null, null])
    })

    it.each(['amount', 'NAME', '', 'name; DROP TABLE app.campaign', 'id'])(
      'falls back to newest first for the unknown column %j',
      async (column) => {
        expect(await ids({ p_sort: column })).toEqual(NEWEST_FIRST)
        expect(await ids({ p_sort: column, p_sort_desc: true })).toEqual(NEWEST_FIRST)
      },
    )

    it('is newest first without a column, whatever the direction', async () => {
      expect(await ids()).toEqual(NEWEST_FIRST)
      expect(await ids({ p_sort_desc: true })).toEqual(NEWEST_FIRST)
    })

    it('sorts the matching rows only', async () => {
      expect(await ids({ p_sort: 'name', p_sort_desc: true, p_company_ids: [ALPHA] })).toEqual([
        C5,
        C2,
        C1,
      ])
    })
  })

  describe('paging', () => {
    it.each<[string, string | undefined]>([
      ['a text column', 'name'],
      ['the status', 'status'],
      ['a column that is null on all of them', 'price'],
      ['the default order', undefined],
    ])('walks rows that tie on %s without repeating or skipping one', async (_what, column) => {
      const tied = await addTiedCampaigns(25)
      const args: ListArgs = { p_company_ids: [GAMMA], p_limit: 7 }
      if (column !== undefined) args.p_sort = column

      const pages = [
        await list({ ...args, p_offset: 0 }),
        await list({ ...args, p_offset: 7 }),
        await list({ ...args, p_offset: 14 }),
        await list({ ...args, p_offset: 21 }),
      ]
      expect(pages.map((page) => page.rows.length)).toEqual([7, 7, 7, 4])
      expect(pages.map((page) => page.total)).toEqual([25, 25, 25, 25])
      // Nothing but the id tells these rows apart, so the id decides.
      expect(pages.flatMap((page) => page.rows.map((row) => row.id))).toEqual(tied)
    })

    it('keeps the order between pages when the sort goes down', async () => {
      const tied = await addTiedCampaigns(25)
      const args: ListArgs = { p_sort: 'company_name', p_sort_desc: true, p_limit: 20 }
      const first = await ids({ ...args, p_offset: 0 })
      const second = await ids({ ...args, p_offset: 20 })
      // Gamma, then beta, then Alpha; inside a company newest first, then by id.
      expect([...first, ...second]).toEqual([...tied, C4, C3, C5, C2, C1])
    })

    it('gives an empty page past the end, with the full total', async () => {
      expect(await list({ p_offset: 5 })).toEqual({ total: 5, rows: [] })
      expect(await list({ p_offset: 5000 })).toEqual({ total: 5, rows: [] })
      const last = await list({ p_offset: 4 })
      expect(last.total).toBe(5)
      expect(last.rows.map((row) => row.id)).toEqual([C1])
    })

    it('clamps the page size to 1–100', async () => {
      await addTiedCampaigns(105)
      expect((await list({ p_limit: 100 })).rows).toHaveLength(100)
      expect((await list({ p_limit: 101 })).rows).toHaveLength(100)
      expect((await list({ p_limit: 100000 })).rows).toHaveLength(100)
      expect((await list({ p_limit: 1 })).rows).toHaveLength(1)
      expect((await list({ p_limit: 0 })).rows).toHaveLength(1)
      expect((await list({ p_limit: -3 })).rows).toHaveLength(1)
      expect((await list({ p_limit: 100000 })).total).toBe(110)
    })

    it('takes a negative offset for the first page', async () => {
      expect(await ids({ p_offset: -4, p_limit: 2 })).toEqual([C5, C4])
      expect(await ids({ p_offset: -4, p_limit: 2 })).toEqual(await ids({ p_limit: 2 }))
    })
  })

  describe('analytics.list_campaign_filter_options', () => {
    it('lists what the campaigns can be filtered by, each value once and sorted', async () => {
      expect(await options()).toEqual({
        // By name without regard to case; Gamma and the seeded company have no campaign.
        companies: [
          { id: ALPHA, name: 'clf Alpha Markets' },
          { id: BETA, name: 'CLF beta Foods' },
        ],
        industries: ['Automotive', 'Retail'],
        managers: ['jonas Frei', 'Mia Keller'],
        sources: ['nexd', 'zeus'],
        countries: [],
        owners: [],
      })
    })

    it('has exactly the six lists', async () => {
      expect(Object.keys(await options()).sort()).toEqual([
        'companies',
        'countries',
        'industries',
        'managers',
        'owners',
        'sources',
      ])
    })

    it('lists a company as soon as it has a campaign, and two of one name as two', async () => {
      await asService()
      const twin = uuid(4)
      await sql(`INSERT INTO app.company (id, name) VALUES ($1, 'clf Alpha Markets')`, [twin])
      await sql(
        `INSERT INTO app.campaign (company_id, name, primary_source) VALUES
           ($1, 'clf gamma first', 'nexd'), ($2, 'clf twin first', 'nexd')`,
        [GAMMA, twin],
      )
      await asReader()
      expect((await options()).companies).toEqual([
        { id: ALPHA, name: 'clf Alpha Markets' },
        { id: twin, name: 'clf Alpha Markets' },
        { id: BETA, name: 'CLF beta Foods' },
        { id: GAMMA, name: 'clf Gamma Idle' },
      ])
    })

    it('offers values the list accepts back', async () => {
      const offered = await options()
      for (const company of offered.companies) {
        expect((await list({ p_company_ids: [company.id] })).total).toBeGreaterThan(0)
      }
      for (const industry of offered.industries) {
        expect((await list({ p_industries: [industry] })).total).toBeGreaterThan(0)
      }
      for (const manager of offered.managers) {
        expect((await list({ p_managers: [manager] })).total).toBeGreaterThan(0)
      }
      for (const source of offered.sources) {
        expect((await list({ p_sources: [source] })).total).toBeGreaterThan(0)
      }
    })

    it('gives six empty lists, never null, when there is no campaign', async () => {
      await asService()
      await sql('DELETE FROM app.campaign')
      await asReader()
      expect(await options()).toEqual({
        companies: [],
        industries: [],
        managers: [],
        sources: [],
        countries: [],
        owners: [],
      })
      expect(await list()).toEqual({ total: 0, rows: [] })
    })
  })

  describe('numbers, delivery, country and owner (0018)', () => {
    // Every campaign has its own case. Numbers come from the primary source only; the other
    // source's rows are there, much larger, so that adding them in would show.
    //
    //   C1  nexd   3 rows over 2 days, 2 languages, 2 tags; zeus rows and zeus devices besides;
    //              an internal CTA; 100 CHF at 12.5 CHF a thousand = 8000 planned
    //   C2  zeus   in_view above impressions one day, no engagement measured, clicks above
    //              impressions; devices with a tablet and an unknown; nexd devices besides
    //   C3  nexd   one day of measured zeros; 100 EUR at 3.123456 EUR = 32015.8 → 32016 planned
    //   C4  nexd   no row at all; an amount in another currency than the price
    //   C5  zeus   in_view not measured; no click row; devices of one day
    const on = (monthDay: string) => `2026-${monthDay}`

    beforeEach(async () => {
      await asService()
      const deal = (
        id: string,
        country: string | null,
        owner: string | null,
        amount: string | null,
        currency: string | null,
      ) =>
        sql(
          `UPDATE app.campaign
              SET country = $2, owner_name = $3, amount = $4::numeric, amount_currency = $5
            WHERE id = $1`,
          [id, country, owner, amount, currency],
        )
      await deal(C1, 'Switzerland', 'Olga Owner', '100', 'CHF')
      await deal(C2, 'belgium', 'anna Berg', '500', 'CHF')
      await deal(C3, null, 'Olga Owner', '100', 'EUR')
      await deal(C4, 'Germany', null, '1000', 'EUR')
      await deal(C5, 'Austria', null, null, null)

      await sql(
        `INSERT INTO analytics.advanced_analytics
           (campaign_id, source, language, campaign_tag, events_date,
            impressions, in_view, game_started, data_source)
         VALUES
           ($1, 'nexd', 'de', 'a', '${on('03-01')}', 1000, 1000,   50, 'sync'),
           ($1, 'nexd', 'fr', 'a', '${on('03-01')}',  500,  450,   10, 'sync'),
           ($1, 'nexd', 'de', 'b', '${on('03-02')}',  700,  600,    4, 'sync'),
           ($1, 'zeus', 'de', '',  '${on('03-01')}', 99999, 99998, 99997, 'sync'),
           ($2, 'zeus', 'de', '',  '${on('06-01')}',  300,  330, NULL, 'sync'),
           ($2, 'zeus', 'de', '',  '${on('06-02')}',  100,   10, NULL, 'sync'),
           ($3, 'nexd', 'de', '',  '${on('09-01')}',    0,    0,    0, 'sync'),
           ($4, 'zeus', 'de', '',  '${on('05-01')}', 77777, 77777, 77777, 'sync'),
           ($5, 'zeus', 'de', 'x', '${on('04-01')}', 5000, NULL,  250, 'sync')`,
        [C1, C2, C3, C4, C5],
      )
      await sql(
        `INSERT INTO analytics.cta (campaign_id, cta_id, name, is_internal_event) VALUES
           ($1, 'go', 'Go', false), ($1, 'swipe', 'Swipe', true),
           ($2, 'clickthrough', 'Click', false),
           ($3, 'clickthrough', 'Click', false)`,
        [C1, C2, C3],
      )
      await sql(
        `INSERT INTO analytics.cta_clicks
           (campaign_id, source, language, campaign_tag, cta_id, events_date, cta_counter, data_source)
         VALUES
           ($1, 'nexd', 'de', 'a', 'go',           '${on('03-01')}',   30, 'sync'),
           ($1, 'nexd', 'de', 'b', 'go',           '${on('03-02')}',    3, 'sync'),
           ($1, 'nexd', 'de', 'a', 'swipe',        '${on('03-01')}',  500, 'sync'),
           ($1, 'zeus', 'de', '',  'go',           '${on('03-01')}', 7777, 'sync'),
           ($2, 'zeus', 'de', '',  'clickthrough', '${on('06-01')}',  500, 'sync'),
           ($3, 'nexd', 'de', '',  'clickthrough', '${on('09-01')}',    0, 'sync')`,
        [C1, C2, C3],
      )
      await sql(
        `INSERT INTO analytics.device_daily
           (campaign_id, source, language, campaign_tag, device_type, events_date, impressions)
         VALUES
           ($1, 'zeus', 'de', '', 'desktop', '${on('03-01')}',   10),
           ($1, 'zeus', 'de', '', 'mobile',  '${on('03-01')}',   20),
           ($2, 'zeus', 'de', '', 'desktop', '${on('06-01')}',  100),
           ($2, 'zeus', 'de', '', 'mobile',  '${on('06-01')}',  120),
           ($2, 'zeus', 'de', '', 'tablet',  '${on('06-01')}',   60),
           ($2, 'zeus', 'de', '', 'unknown', '${on('06-01')}',   20),
           ($2, 'zeus', 'de', '', 'desktop', '${on('06-02')}',   40),
           ($2, 'zeus', 'de', '', 'mobile',  '${on('06-02')}',   50),
           ($2, 'zeus', 'de', '', 'tablet',  '${on('06-02')}',   10),
           ($2, 'nexd', 'de', '', 'desktop', '${on('06-01')}', 9999),
           ($3, 'zeus', 'de', 'x', 'desktop', '${on('04-01')}', 1000),
           ($3, 'zeus', 'de', 'x', 'mobile',  '${on('04-01')}', 3000),
           ($3, 'zeus', 'de', 'x', 'tablet',  '${on('04-01')}',  500),
           ($3, 'zeus', 'de', 'x', 'unknown', '${on('04-01')}',  500)`,
        [C1, C2, C5],
      )
      await asReader()
    })

    const rowOf = async (id: string, args: ListArgs = {}): Promise<CampaignRow> => {
      const row = (await list({ p_limit: 100, ...args })).rows.find((r) => r.id === id)
      if (!row) throw new Error(`campaign ${id} is not on the page`)
      return row
    }
    const numbersOf = async (id: string, args: ListArgs = {}) => {
      const row = await rowOf(id, args)
      return Object.fromEntries(NUMBER_KEYS.map((key) => [key, row[key]]))
    }
    /** A number as the JSON text the function wrote, to see its decimals. */
    const rawOf = async (id: string, key: string): Promise<string | null> => {
      const [row] = await sql<{ value: string | null }>(
        `SELECT row->$2 #>> '{}' AS value
           FROM jsonb_array_elements(analytics.list_campaigns(p_limit => 100)->'rows') AS row
          WHERE row->>'id' = $1`,
        [id, key],
      )
      return row?.value ?? null
    }

    describe('a campaign’s numbers', () => {
      it.each<[string, string, Record<string, number | null>]>([
        [
          'added up over days, languages and tags, from its primary source only',
          C1,
          {
            impressions: 2200,
            viewable_impressions: 2050,
            engagements: 64,
            clicks: 33,
            engagement_rate: 0.0291,
            ctr: 0.015,
            viewability: 0.9318,
            desktop_impressions: null,
            mobile_impressions: null,
            desktop_share: null,
            mobile_share: null,
            planned_impressions: 8000,
            delivered_impressions: 2200,
            delivery: 0.275,
          },
        ],
        [
          'as reported, never clamped, with what is not measured left null',
          C2,
          {
            impressions: 400,
            viewable_impressions: 340,
            engagements: null,
            clicks: 500,
            engagement_rate: null,
            ctr: 1.25,
            viewability: 0.85,
            desktop_impressions: 140,
            mobile_impressions: 240,
            desktop_share: 0.35,
            mobile_share: 0.6,
            planned_impressions: null,
            delivered_impressions: 400,
            delivery: null,
          },
        ],
        [
          'measured zeros: 0, and no rate over them',
          C3,
          {
            impressions: 0,
            viewable_impressions: 0,
            engagements: 0,
            clicks: 0,
            engagement_rate: null,
            ctr: null,
            viewability: null,
            desktop_impressions: null,
            mobile_impressions: null,
            desktop_share: null,
            mobile_share: null,
            planned_impressions: 32016,
            delivered_impressions: 0,
            delivery: 0,
          },
        ],
        ['nothing from its primary source: all null, never 0', C4, NO_NUMBERS],
        [
          'a metric its source does not measure stays null beside the ones it does',
          C5,
          {
            impressions: 5000,
            viewable_impressions: null,
            engagements: 250,
            clicks: null,
            engagement_rate: 0.05,
            ctr: null,
            viewability: null,
            desktop_impressions: 1000,
            mobile_impressions: 3500,
            desktop_share: 0.2,
            mobile_share: 0.7,
            planned_impressions: null,
            delivered_impressions: 5000,
            delivery: null,
          },
        ],
      ])('%s', async (_what, id, expected) => {
        expect(await numbersOf(id)).toEqual(expected)
      })

      it('follows the primary source when it changes, and never adds the other one in', async () => {
        await asService()
        await sql(`UPDATE app.campaign SET primary_source = 'zeus' WHERE id = $1`, [C1])
        await asReader()
        expect(await numbersOf(C1)).toEqual({
          impressions: 99999,
          viewable_impressions: 99998,
          engagements: 99997,
          clicks: 7777,
          engagement_rate: 1,
          ctr: 0.0778,
          viewability: 1,
          desktop_impressions: 10,
          mobile_impressions: 20,
          desktop_share: 0.3333,
          mobile_share: 0.6667,
          planned_impressions: 8000,
          delivered_impressions: 99999,
          delivery: 12.4999,
        })
      })

      it('carries the deal’s country and owner as stored', async () => {
        expect(await rowOf(C1)).toMatchObject({ country: 'Switzerland', owner_name: 'Olga Owner' })
        expect(await rowOf(C3)).toMatchObject({ country: null, owner_name: 'Olga Owner' })
        expect(await rowOf(C4)).toMatchObject({ country: 'Germany', owner_name: null })
      })
    })

    describe('rates', () => {
      it('divide the sums, not the rows: 64 of 2200 is not the mean of 5%, 2% and 0.6%', async () => {
        expect((await rowOf(C1)).engagement_rate).toBe(0.0291)
      })

      it('are rounded once to 4 decimals, half away from zero', async () => {
        await asService()
        await sql(
          `INSERT INTO analytics.advanced_analytics
             (campaign_id, source, language, campaign_tag, events_date, impressions, in_view, game_started, data_source)
           VALUES ($1, 'nexd', 'de', '', '2026-05-01', 32, 3, 1, 'sync')`,
          [C4],
        )
        await asReader()
        // 1/32 = 0.03125 and 3/32 = 0.09375: exactly half way, so up.
        expect(await rawOf(C4, 'engagement_rate')).toBe('0.0313')
        expect(await rawOf(C4, 'viewability')).toBe('0.0938')
        // 2050/2200 = 0.931818…, 64/2200 = 0.0290909…
        expect(await rawOf(C1, 'viewability')).toBe('0.9318')
        expect(await rawOf(C1, 'engagement_rate')).toBe('0.0291')
        expect(await rawOf(C1, 'delivery')).toBe('0.2750')
      })

      it('are null when the impressions are not measured, beside what is', async () => {
        await asService()
        await sql(
          `INSERT INTO analytics.advanced_analytics
             (campaign_id, source, language, campaign_tag, events_date, impressions, in_view, game_started, data_source)
           VALUES ($1, 'nexd', 'de', '', '2026-05-01', NULL, NULL, 5, 'sync')`,
          [C4],
        )
        await asReader()
        expect(await numbersOf(C4)).toMatchObject({
          impressions: null,
          engagements: 5,
          engagement_rate: null,
          delivered_impressions: null,
        })
      })

      it('are null over zero impressions, never 0 and never an error', async () => {
        expect(await numbersOf(C3)).toMatchObject({
          impressions: 0,
          engagement_rate: null,
          ctr: null,
          viewability: null,
        })
      })
    })

    describe('clicks', () => {
      it('never count an internal CTA event', async () => {
        // C1's swipe (internal) has 500 that day; only the two of `go` count.
        expect((await rowOf(C1)).clicks).toBe(33)
      })

      it('are null when only internal events were clicked', async () => {
        await asService()
        await sql(`DELETE FROM analytics.cta_clicks WHERE campaign_id = $1 AND cta_id = 'go'`, [C1])
        await asReader()
        expect(await numbersOf(C1)).toMatchObject({ clicks: null, ctr: null })
      })
    })

    describe('the window', () => {
      it.each<[string, ListArgs, Record<string, number | null>]>([
        [
          'from a day on, that day included',
          { p_from: '2026-03-02' },
          { impressions: 700, viewable_impressions: 600, engagements: 4, clicks: 3 },
        ],
        [
          'up to a day, that day included',
          { p_to: '2026-03-01' },
          { impressions: 1500, viewable_impressions: 1450, engagements: 60, clicks: 30 },
        ],
        [
          'one day, both bounds on it',
          { p_from: '2026-03-02', p_to: '2026-03-02' },
          { impressions: 700, viewable_impressions: 600, engagements: 4, clicks: 3 },
        ],
        [
          'both days',
          { p_from: '2026-03-01', p_to: '2026-03-02' },
          { impressions: 2200, viewable_impressions: 2050, engagements: 64, clicks: 33 },
        ],
        [
          'open on both sides',
          { p_from: null, p_to: null },
          { impressions: 2200, viewable_impressions: 2050, engagements: 64, clicks: 33 },
        ],
        [
          'days without a row: null, not 0',
          { p_from: '2026-03-03', p_to: '2026-03-31' },
          { impressions: null, viewable_impressions: null, engagements: null, clicks: null },
        ],
        [
          'a window that ends before it starts: no day, so null',
          { p_from: '2026-03-02', p_to: '2026-03-01' },
          { impressions: null, viewable_impressions: null, engagements: null, clicks: null },
        ],
      ])('covers %s', async (_what, args, expected) => {
        expect(await numbersOf(C1, args)).toMatchObject(expected)
      })

      it('covers the device split too', async () => {
        expect(await numbersOf(C2, { p_from: '2026-06-02' })).toMatchObject({
          desktop_impressions: 40,
          mobile_impressions: 60,
          desktop_share: 0.4,
          mobile_share: 0.6,
        })
      })

      it('never covers delivery: that is always the whole campaign', async () => {
        for (const args of [{ p_from: '2026-03-02' }, { p_to: '2026-01-01' }]) {
          expect(await numbersOf(C1, args)).toMatchObject({
            planned_impressions: 8000,
            delivered_impressions: 2200,
            delivery: 0.275,
          })
        }
      })

      it('changes the numbers, never which campaigns match or how many', async () => {
        const all = await list()
        for (const args of [
          { p_from: '2030-01-01' },
          { p_to: '2000-01-01' },
          { p_from: '2026-03-01', p_to: '2026-03-01' },
        ]) {
          const windowed = await list(args)
          expect(windowed.total).toBe(all.total)
          expect(windowed.rows.map((row) => row.id)).toEqual(all.rows.map((row) => row.id))
        }
        const filtered = { p_status: 'active', p_sources: ['zeus'] }
        expect(await idSet({ ...filtered, p_from: '2030-01-01' })).toEqual(await idSet(filtered))
      })

      it('decides a sort by a number', async () => {
        expect(await ids({ p_sort: 'impressions', p_to: '2026-03-01', p_sort_desc: true })).toEqual(
          [C1, C5, C4, C3, C2],
        )
      })
    })

    describe('devices', () => {
      it('count a tablet as mobile, and unknown only in the whole the shares divide', async () => {
        const row = await numbersOf(C2)
        expect(row.mobile_impressions).toBe(120 + 60 + 50 + 10)
        expect(row.desktop_impressions).toBe(140)
        // 140 + 240 + 20 unknown = 400: the two shares leave out the unknown 5%.
        expect(Number(row.desktop_share) + Number(row.mobile_share)).toBeCloseTo(0.95, 10)
      })

      it('are null without a device row of the primary source', async () => {
        // C1 is on NEXD, which has no device rows; its Zeus ones do not count.
        expect(await numbersOf(C1)).toMatchObject({
          desktop_impressions: null,
          mobile_impressions: null,
          desktop_share: null,
          mobile_share: null,
        })
      })

      it('leave a device the source sent no row for null, not 0', async () => {
        await asService()
        await sql(
          `DELETE FROM analytics.device_daily WHERE campaign_id = $1 AND device_type = 'desktop'`,
          [C5],
        )
        await asReader()
        expect(await numbersOf(C5)).toMatchObject({
          desktop_impressions: null,
          desktop_share: null,
          mobile_impressions: 3500,
          mobile_share: 0.875,
        })
      })

      it('keep a measured 0 as 0, with no share of nothing', async () => {
        await asService()
        await sql(
          `INSERT INTO analytics.device_daily
             (campaign_id, source, language, campaign_tag, device_type, events_date, impressions)
           VALUES ($1, 'nexd', 'de', '', 'desktop', '2026-09-01', 0),
                  ($1, 'nexd', 'de', '', 'mobile',  '2026-09-01', 0)`,
          [C3],
        )
        await asReader()
        expect(await numbersOf(C3)).toMatchObject({
          desktop_impressions: 0,
          mobile_impressions: 0,
          desktop_share: null,
          mobile_share: null,
        })
      })
    })

    describe('planned impressions and delivery', () => {
      const setDeal = async (
        amount: string | null,
        amountCurrency: string | null,
        price: string | null,
        currency: string | null,
      ) => {
        await asService()
        await sql(
          `UPDATE app.campaign
              SET amount = $2::numeric, amount_currency = $3, price = $4::numeric, currency = $5
            WHERE id = $1`,
          [C1, amount, amountCurrency, price, currency],
        )
        await asReader()
      }

      it('are the amount over the price a thousand: 1000 at 2.5 is 400000', async () => {
        await setDeal('1000', 'CHF', '2.5', 'CHF')
        expect(await numbersOf(C1)).toMatchObject({
          planned_impressions: 400000,
          delivered_impressions: 2200,
          delivery: 0.0055,
        })
      })

      it('round to a whole impression, half away from zero', async () => {
        await setDeal('3', 'CHF', '2000', 'CHF')
        expect((await rowOf(C1)).planned_impressions).toBe(2)
        expect(await rawOf(C1, 'planned_impressions')).toBe('2')
        // C3: 100 EUR at 3.123456 = 32015.82…
        expect(await rawOf(C3, 'planned_impressions')).toBe('32016')
      })

      it.each<[string, [string | null, string | null, string | null, string | null]]>([
        ['without an amount', [null, null, '12.5', 'CHF']],
        ['without a price', ['100', 'CHF', null, null]],
        ['with a price of 0: given away', ['100', 'CHF', '0', 'CHF']],
        [
          'when the amount and the price are in different currencies',
          ['100', 'EUR', '12.5', 'CHF'],
        ],
      ])('are null %s', async (_what, deal) => {
        await setDeal(...deal)
        expect(await numbersOf(C1)).toMatchObject({
          planned_impressions: null,
          delivered_impressions: 2200,
          delivery: null,
        })
      })

      it('give no delivery against 0 planned impressions', async () => {
        await setDeal('0', 'CHF', '12.5', 'CHF')
        expect(await numbersOf(C1)).toMatchObject({ planned_impressions: 0, delivery: null })
      })

      it('let over-delivery stay above 1', async () => {
        await setDeal('1', 'CHF', '1', 'CHF')
        expect(await numbersOf(C1)).toMatchObject({ planned_impressions: 1000, delivery: 2.2 })
      })

      it('are null for a campaign that delivered nothing yet', async () => {
        expect(await numbersOf(C4)).toMatchObject({
          planned_impressions: null,
          delivered_impressions: null,
          delivery: null,
        })
        await asService()
        await sql(`UPDATE app.campaign SET amount_currency = 'CHF' WHERE id = $1`, [C4])
        await asReader()
        expect(await numbersOf(C4)).toMatchObject({
          planned_impressions: 50000,
          delivered_impressions: null,
          delivery: null,
        })
      })
    })

    describe('sort', () => {
      // Nulls last in both directions, ties newest first: C5, C4, C3, C2, C1.
      it.each<[string, string[], string[]]>([
        ['impressions', [C3, C2, C1, C5, C4], [C5, C1, C2, C3, C4]],
        ['viewable_impressions', [C3, C2, C1, C5, C4], [C1, C2, C3, C5, C4]],
        ['engagements', [C3, C1, C5, C4, C2], [C5, C1, C3, C4, C2]],
        ['engagement_rate', [C1, C5, C4, C3, C2], [C5, C1, C4, C3, C2]],
        ['clicks', [C3, C1, C2, C5, C4], [C2, C1, C3, C5, C4]],
        ['ctr', [C1, C2, C5, C4, C3], [C2, C1, C5, C4, C3]],
        ['viewability', [C2, C1, C5, C4, C3], [C1, C2, C5, C4, C3]],
        ['desktop_share', [C5, C2, C4, C3, C1], [C2, C5, C4, C3, C1]],
        ['planned_impressions', [C1, C3, C5, C4, C2], [C3, C1, C5, C4, C2]],
        ['delivery', [C3, C1, C5, C4, C2], [C1, C3, C5, C4, C2]],
        ['country', [C5, C2, C4, C1, C3], [C1, C4, C2, C5, C3]],
        ['owner_name', [C2, C3, C1, C5, C4], [C3, C1, C2, C5, C4]],
      ])('by %s, up and down', async (column, ascending, descending) => {
        expect(await ids({ p_sort: column }), 'ascending by default').toEqual(ascending)
        expect(await ids({ p_sort: column, p_sort_desc: false }), 'ascending').toEqual(ascending)
        expect(await ids({ p_sort: column, p_sort_desc: true }), 'descending').toEqual(descending)
      })

      it.each([
        'name',
        'company_name',
        'status',
        'industry',
        'starts_on',
        'ends_on',
        'primary_source',
        'price',
        'manager_name',
        'created_at',
        'updated_at',
        'impressions',
        'viewable_impressions',
        'engagements',
        'engagement_rate',
        'clicks',
        'ctr',
        'viewability',
        'desktop_share',
        'planned_impressions',
        'delivery',
        'country',
        'owner_name',
        'not a column',
      ])('cuts the order by %s into pages, both ways, without changing it', async (column) => {
        // A sort by a summed number ranks every campaign before the page is cut; any other cuts
        // the page first. Either way a page must be a slice of the whole order.
        for (const descending of [false, true]) {
          const args: ListArgs = { p_sort: column, p_sort_desc: descending }
          const whole = await ids(args)
          const paged = [
            ...(await ids({ ...args, p_limit: 2, p_offset: 0 })),
            ...(await ids({ ...args, p_limit: 2, p_offset: 2 })),
            ...(await ids({ ...args, p_limit: 2, p_offset: 4 })),
          ]
          expect(paged, descending ? 'descending' : 'ascending').toEqual(whole)
        }
      })

      it('pages a sort by a number like any other: clamped size, no negative offset, an empty page past the end', async () => {
        const order = [C3, C2, C1, C5, C4]
        expect(await ids({ p_sort: 'impressions', p_offset: -4, p_limit: 2 })).toEqual(
          order.slice(0, 2),
        )
        expect(await ids({ p_sort: 'impressions', p_limit: 0 })).toEqual(order.slice(0, 1))
        expect(await ids({ p_sort: 'impressions', p_limit: -3 })).toEqual(order.slice(0, 1))
        expect(await ids({ p_sort: 'impressions', p_offset: 4 })).toEqual(order.slice(4))
        expect(await list({ p_sort: 'impressions', p_offset: 5 })).toEqual({ total: 5, rows: [] })
        await addTiedCampaigns(105)
        const big = await list({ p_sort: 'impressions', p_limit: 101 })
        expect(big.total).toBe(110)
        expect(big.rows).toHaveLength(100)
        expect((await list({ p_sort: 'impressions' })).rows).toHaveLength(10)
        expect(
          (await list({ p_sort: 'impressions', p_limit: null, p_offset: null })).rows,
        ).toHaveLength(10)
      })

      it('still sorts by the names of 0017', async () => {
        expect(await ids({ p_sort: 'name' })).toEqual([C1, C2, C3, C4, C5])
        expect(await ids({ p_sort: 'price', p_sort_desc: true })).toEqual([C4, C1, C3, C5, C2])
      })

      it('has every row’s numbers on a page cut after the sort', async () => {
        // By a number, every campaign's numbers are needed before the page is cut; by anything
        // else only the page's. Both must give the rows on a later page their own numbers.
        const byNumber = await list({ p_sort: 'impressions', p_limit: 2, p_offset: 1 })
        expect(byNumber.total).toBe(5)
        expect(byNumber.rows.map((row) => [row.id, row.impressions, row.clicks])).toEqual([
          [C2, 400, 500],
          [C1, 2200, 33],
        ])
        const byName = await list({ p_sort: 'name', p_limit: 2, p_offset: 2 })
        expect(byName.total).toBe(5)
        expect(
          byName.rows.map((row) => [row.id, row.impressions, row.planned_impressions]),
        ).toEqual([
          [C3, 0, 32016],
          [C4, null, null],
        ])
        const newest = await list({ p_limit: 2, p_offset: 3 })
        expect(newest.rows.map((row) => [row.id, row.impressions, row.delivery])).toEqual([
          [C2, 400, null],
          [C1, 2200, 0.275],
        ])
      })

      it.each([['impressions'], ['delivery'], ['ctr']])(
        'walks rows that tie on %s without repeating or skipping one',
        async (column) => {
          const tied = await addTiedCampaigns(25)
          // Half of them with the same numbers, the other half with none.
          await asService()
          await sql(
            `INSERT INTO analytics.advanced_analytics
               (campaign_id, source, language, campaign_tag, events_date, impressions, data_source)
             SELECT id, 'nexd', 'de', '', '2026-01-10', 100, 'sync'
               FROM unnest($1::uuid[]) AS id`,
            [tied.slice(0, 12)],
          )
          await asReader()
          for (const descending of [false, true]) {
            const args: ListArgs = {
              p_company_ids: [GAMMA],
              p_sort: column,
              p_sort_desc: descending,
              p_limit: 7,
            }
            const pages = [
              await list({ ...args, p_offset: 0 }),
              await list({ ...args, p_offset: 7 }),
              await list({ ...args, p_offset: 14 }),
              await list({ ...args, p_offset: 21 }),
            ]
            expect(pages.map((page) => page.total)).toEqual([25, 25, 25, 25])
            const walked = pages.flatMap((page) => page.rows.map((row) => row.id))
            expect(walked).toHaveLength(25)
            expect(new Set(walked).size).toBe(25)
            if (column === 'impressions') {
              // The twelve with 100 impressions, by id; then the thirteen without, by id.
              expect(walked).toEqual([...tied.slice(0, 12).sort(), ...tied.slice(12).sort()])
            } else {
              // No price and no click: null for all of them, so the id decides.
              expect(walked).toEqual(tied)
            }
          }
        },
      )
    })

    describe('filters', () => {
      it('by country, any of the listed, as stored', async () => {
        expect(await idSet({ p_countries: ['Austria'] })).toEqual([C5])
        expect(await idSet({ p_countries: ['Austria', 'Germany'] })).toEqual([C4, C5])
        expect(await idSet({ p_countries: ['austria'] })).toEqual([])
        expect(await idSet({ p_countries: [] })).toEqual([])
      })

      it('by owner, any of the listed, as stored', async () => {
        expect(await idSet({ p_owners: ['Olga Owner'] })).toEqual([C1, C3])
        expect(await idSet({ p_owners: ['Olga Owner', 'anna Berg'] })).toEqual([C1, C2, C3])
        expect(await idSet({ p_owners: ['olga owner'] })).toEqual([])
      })

      it('combine with the others by AND', async () => {
        expect(await idSet({ p_owners: ['Olga Owner'], p_status: 'active' })).toEqual([C1])
        expect(await idSet({ p_owners: ['Olga Owner'], p_countries: ['Switzerland'] })).toEqual([
          C1,
        ])
        const none = await list({ p_owners: ['anna Berg'], p_countries: ['Germany'] })
        expect(none).toEqual({ total: 0, rows: [] })
      })

      it('leave search as it was: it does not look at the country or the owner', async () => {
        expect(await idSet({ p_search: 'Switzerland' })).toEqual([])
        expect(await idSet({ p_search: 'Olga' })).toEqual([])
      })

      it('are offered: each country and owner once, sorted without regard to case', async () => {
        const offered = await options()
        expect(offered.countries).toEqual(['Austria', 'belgium', 'Germany', 'Switzerland'])
        expect(offered.owners).toEqual(['anna Berg', 'Olga Owner'])
        for (const country of offered.countries) {
          expect((await list({ p_countries: [country] })).total).toBeGreaterThan(0)
        }
        for (const owner of offered.owners) {
          expect((await list({ p_owners: [owner] })).total).toBeGreaterThan(0)
        }
      })
    })
  })
})
