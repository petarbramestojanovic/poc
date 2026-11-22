import { beforeEach, describe, expect, it } from 'vitest'
import { at } from '../helpers.ts'
import { sqlstateOf, useTransactionalClient } from './db.ts'

// Migration 0017: the two functions the frontend lists campaigns with. They are SECURITY DEFINER,
// because a reader has no grant on app.company and gets a company's name here and nowhere else.
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
  'analytics.list_campaigns(text,text,uuid[],text[],text[],text[],date,date,text,boolean,integer,integer)'
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

const ROW_KEYS = [
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
}>

describe('migration 0017_campaign_list_functions', () => {
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

    it('returns of app.campaign only columns a reader may select anyway', async () => {
      const rows = await sql<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'campaign'
            AND has_column_privilege('authenticated', 'app.campaign', column_name, 'SELECT')`,
      )
      const readable = new Set(rows.map((row) => row.column_name))
      // The company's name and the platforms come from other tables.
      const fromCampaign = ROW_KEYS.filter((key) => key !== 'company_name' && key !== 'sources')
      expect(fromCampaign).toHaveLength(15)
      for (const key of fromCampaign) expect(readable.has(key), key).toBe(true)
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
      await asReader()

      const page = await list()
      for (const row of page.rows) expect(Object.keys(row).sort()).toEqual(ROW_KEYS)
      const text = JSON.stringify(page)
      for (const closed of [
        '98765.43',
        'Closed Deal Type',
        'Closedland',
        'Closed Creative',
        'Olga Owner',
        'm-1',
        '006CLOSEDREF000001',
        'clf-closed-legacy',
      ]) {
        expect(text, closed).not.toContain(closed)
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
      })
    })

    it('has exactly the four lists', async () => {
      expect(Object.keys(await options()).sort()).toEqual([
        'companies',
        'industries',
        'managers',
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

    it('gives four empty lists, never null, when there is no campaign', async () => {
      await asService()
      await sql('DELETE FROM app.campaign')
      await asReader()
      expect(await options()).toEqual({ companies: [], industries: [], managers: [], sources: [] })
      expect(await list()).toEqual({ total: 0, rows: [] })
    })
  })
})
