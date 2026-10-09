import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { campaignSetupSchema, type CampaignSetup } from '../../src/modules/campaigns/input.ts'
import {
  nexdPresetSchema,
  nexdSetup,
  zeusPresetSchema,
  zeusSetup,
} from '../../src/modules/campaigns/presets.ts'
import { setUpCampaign, type CampaignDeps } from '../../src/modules/campaigns/service.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import { createLogger } from '../../src/core/log.ts'
import { createDefaultRegistry } from '../../src/modules/sync/connectors/index.ts'
import { at } from '../helpers.ts'
import { sqlstateOf } from './db.ts'

// The setup service against the real schema, with the real connectors deciding what a link may
// hold. Every row this file writes hangs off a company named 'IT Setup …' and uses platform ids
// starting with 'it-setup-', which no other test file touches.

const REF = { system: 'salesforce', id: 'it-setup-006A000000XYZ' }
const ZEUS_CREDENTIAL = '00000000-0000-4000-8000-000000000012'

/** A CampaignSetup with friendly platform blocks turned into links by the presets. */
function setup(
  over: Record<string, unknown> = {},
  sources: { zeus?: unknown; nexd?: unknown } = {},
): CampaignSetup {
  return campaignSetupSchema.parse({
    company: { name: 'IT Setup Rauch' },
    name: 'IT Setup Cafemio',
    startsOn: '2026-06-30',
    endsOn: '2026-09-30',
    ...over,
    sources: [
      ...(sources.zeus ? [zeusSetup(zeusPresetSchema.parse(sources.zeus))] : []),
      ...(sources.nexd ? [nexdSetup(nexdPresetSchema.parse(sources.nexd))] : []),
    ],
  })
}

const zeus = (over: Record<string, unknown> = {}) => ({
  zeus: { campaignId: 'it-setup-18', idType: 'internal_id', ...over },
})
const nexd = { nexd: { creatives: [{ liveId: 'it-setup-nx-1', label: 'V1' }] } }

describe('campaign setup', () => {
  let db: Db
  let deps: CampaignDeps

  const cleanup = async () => {
    await db.query(
      `DELETE FROM app.campaign WHERE company_id IN (SELECT id FROM app.company WHERE name LIKE 'IT Setup%')`,
    )
    await db.query(`DELETE FROM app.company WHERE name LIKE 'IT Setup%'`)
    await db.query(`DELETE FROM external.credential WHERE name LIKE 'it-setup-%'`)
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    deps = { db, registry: createDefaultRegistry(), log: createLogger('silent') }
    await cleanup()
  })
  afterEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await db.close()
  })

  /** The stored columns themselves, by name: the insert and update pass them positionally. */
  const storedPrice = async (campaignId: string) =>
    at(
      await db.query<{ price: string | null; currency: string | null }>(
        'SELECT price::text AS price, currency FROM app.campaign WHERE id = $1',
        [campaignId],
      ),
    )

  const entitiesOf = (linkId: string) =>
    db.query<{ level: string; external_id: string; role: string | null; campaign_tag: string }>(
      `SELECT level, external_id, role, campaign_tag FROM external.link_entity
        WHERE link_id = $1 ORDER BY level, external_id`,
      [linkId],
    )

  describe('a campaign set up with its platform ids', () => {
    it('creates everything a sync needs, in one go', async () => {
      const result = await setUpCampaign(
        deps,
        setup(
          { primarySource: 'zeus' },
          { ...zeus({ pixels: [{ code: 'it-setup-eng', role: 'engagement' }] }), ...nexd },
        ),
      )

      expect(result.created).toBe(true)
      expect(result.company).toMatchObject({ name: 'IT Setup Rauch', externalRef: null })
      expect(result.campaign).toMatchObject({
        name: 'IT Setup Cafemio',
        primarySource: 'zeus',
        timezone: 'Europe/Zurich',
        status: 'active',
        startsOn: '2026-06-30',
        endsOn: '2026-09-30',
      })
      expect(result.links.map((l) => [l.source, l.created, l.entitiesAdded])).toEqual([
        ['zeus', true, 2],
        ['nexd', true, 1],
      ])

      // The Zeus link is exactly what was set up by hand for the first real campaign.
      const zeusLink = at(result.links)
      const [link] = await db.query<{ credential_id: string; config: unknown; language: string }>(
        'SELECT credential_id, config, language FROM external.campaign_link WHERE id = $1',
        [zeusLink.id],
      )
      expect(link).toEqual({
        credential_id: ZEUS_CREDENTIAL, // the source's only credential, so it need not be named
        config: { clickthrough_cta_id: 'clickthrough', campaign_id_param: 'internal_id' },
        language: '',
      })
      expect(await entitiesOf(zeusLink.id)).toEqual([
        { level: 'campaign', external_id: 'it-setup-18', role: null, campaign_tag: '' },
        { level: 'pixel', external_id: 'it-setup-eng', role: 'engagement', campaign_tag: '' },
      ])

      // The CTA the Zeus config points at, and NEXD's two standard events.
      const ctas = await db.query('SELECT cta_id FROM analytics.cta WHERE campaign_id = $1', [
        result.campaign.id,
      ])
      expect(ctas).toEqual([{ cta_id: 'clickthrough' }])
      const events = await db.query(
        `SELECT event_name, target_kind, target_id FROM external.event_map
          WHERE link_id = $1 ORDER BY event_name`,
        [at(result.links, 1).id],
      )
      expect(events).toEqual([
        { event_name: 'Unique [Hover]', target_kind: 'metric', target_id: 'hovered' },
        { event_name: 'Unique [Touch]', target_kind: 'metric', target_id: 'interactions' },
      ])
    })

    it('picks the headline nobody chose: Zeus first, NEXD when it is the only one', async () => {
      const single = await setUpCampaign(deps, setup({}, nexd))
      const both = await setUpCampaign(
        deps,
        setup(
          { company: { name: 'IT Setup Two Co' }, name: 'IT Setup Two' },
          {
            ...zeus({ campaignId: 'it-setup-19' }),
            nexd: { creatives: [{ liveId: 'it-setup-nx-2' }] },
          },
        ),
      )
      // A campaign from the CRM has no platform ids yet.
      const none = await setUpCampaign(
        deps,
        setup({ company: { name: 'IT Setup None Co' }, name: 'IT Setup None' }),
      )

      expect([single, both, none].map((result) => result.campaign.primarySource)).toEqual([
        'nexd',
        'zeus',
        'zeus',
      ])
    })

    it('can exist before any platform id is known', async () => {
      const result = await setUpCampaign(deps, setup({ primarySource: 'nexd', status: 'draft' }))
      expect(result.links).toEqual([])
      expect(result.campaign).toMatchObject({ primarySource: 'nexd', status: 'draft' })
    })

    it('stores the price exactly, and no price as NULL rather than 0', async () => {
      const priced = await setUpCampaign(
        deps,
        setup({ price: { value: 15.5876, currency: 'EUR' } }, zeus()),
      )
      const unpriced = await setUpCampaign(
        deps,
        setup({ name: 'IT Setup Unpriced', company: { id: priced.company.id } }, nexd),
      )

      expect(priced.campaign.price).toEqual({ value: 15.5876, currency: 'EUR' })
      expect(await storedPrice(priced.campaign.id)).toEqual({ price: '15.5876', currency: 'EUR' })
      expect(unpriced.campaign.price).toBeNull()
      expect(await storedPrice(unpriced.campaign.id)).toEqual({ price: null, currency: null })
    })

    it('derives the campaign languages from its links', async () => {
      const result = await setUpCampaign(deps, setup({}, zeus({ language: 'de' })))
      expect(result.campaign.languages).toEqual(['de'])
    })
  })

  describe('what it refuses, writing nothing', () => {
    const campaigns = async () =>
      at(
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.campaign c JOIN app.company co ON co.id = c.company_id
            WHERE co.name LIKE 'IT Setup%'`,
        ),
      ).n

    it('a platform id that already belongs to another campaign', async () => {
      await setUpCampaign(deps, setup({}, zeus()))

      await expect(
        setUpCampaign(
          deps,
          setup({ company: { name: 'IT Setup Other' }, name: 'IT Setup Twin' }, zeus()),
        ),
      ).rejects.toMatchObject({
        code: 'entity_in_use',
        status: 409,
        message: expect.stringContaining('IT Setup Cafemio') as unknown,
      })
      // One transaction: the twin's company and campaign were rolled back with it.
      expect(await campaigns()).toBe(1)
      expect(await db.query(`SELECT 1 FROM app.company WHERE name = 'IT Setup Other'`)).toEqual([])
    })

    it('a company name that already exists, until the caller says which company it means', async () => {
      const first = await setUpCampaign(deps, setup({}, zeus()))

      await expect(
        setUpCampaign(
          deps,
          setup({ company: { name: 'it setup rauch' }, name: 'IT Setup B' }, nexd),
        ),
      ).rejects.toMatchObject({ code: 'company_name_exists', status: 409 })

      const second = await setUpCampaign(
        deps,
        setup({ company: { id: first.company.id }, name: 'IT Setup B' }, nexd),
      )
      expect(second.company.id).toBe(first.company.id)
    })

    it('a company id that does not exist', async () => {
      await expect(
        setUpCampaign(
          deps,
          setup({ company: { id: '00000000-0000-4000-8000-00000000dead' } }, zeus()),
        ),
      ).rejects.toMatchObject({ code: 'company_not_found', status: 422 })
    })

    it('a headline source that does not exist', async () => {
      await expect(
        setUpCampaign(deps, setup({ primarySource: 'adnuntius' }, zeus())),
      ).rejects.toMatchObject({ code: 'unsupported_source', status: 422 })
      expect(await campaigns()).toBe(0)
    })

    it('an unnamed credential once the source has two', async () => {
      await db.query(
        `INSERT INTO external.credential (source_id, name, secret_env_var)
         VALUES ('zeus', 'it-setup-zeus-2', 'ZEUS_API_TOKEN')`,
      )

      await expect(setUpCampaign(deps, setup({}, zeus()))).rejects.toMatchObject({
        code: 'credential_not_resolved',
        status: 422,
      })
      const named = await setUpCampaign(deps, setup({}, zeus({ credential: 'zeus-main' })))
      expect(at(named.links).created).toBe(true)
    })
  })

  describe('a campaign pushed by another system', () => {
    const push = (over: Record<string, unknown> = {}, sources: Record<string, unknown> = {}) =>
      setUpCampaign(
        deps,
        setup(
          {
            externalRef: REF,
            company: {
              name: 'IT Setup Rauch',
              externalRef: { system: 'salesforce', id: 'it-setup-001' },
            },
            ...over,
          },
          sources,
        ),
      )

    it('creates it the first time and finds it the second', async () => {
      const first = await push({ primarySource: 'zeus' })
      const second = await push({ name: 'IT Setup Cafemio (renamed)' })

      expect([first.created, second.created]).toEqual([true, false])
      expect([first.updated, second.updated]).toEqual([false, true])
      expect(second.campaign.id).toBe(first.campaign.id)
      expect(second.company.id).toBe(first.company.id)
      expect(second.campaign.name).toBe('IT Setup Cafemio (renamed)')
      expect(second.campaign.externalRef).toEqual(REF)
    })

    it('adds the ids that arrive later and never removes the ones it has', async () => {
      // The CRM record exists before ad ops know any platform id.
      await push({ primarySource: 'zeus' })
      // Then the ATK campaign and its engagement pixel are filled in…
      const withZeus = await push(
        {},
        zeus({ pixels: [{ code: 'it-setup-eng', role: 'engagement' }] }),
      )
      // …and later the finish pixel and a NEXD creative, in a push that forgot the first pixel.
      const later = await push(
        {},
        { ...zeus({ pixels: [{ code: 'it-setup-fin', role: 'finish' }] }), ...nexd },
      )

      expect(at(withZeus.links)).toMatchObject({ source: 'zeus', created: true, entitiesAdded: 2 })
      expect(later.links.map((l) => [l.source, l.created, l.entitiesAdded])).toEqual([
        ['zeus', false, 1],
        ['nexd', true, 1],
      ])
      expect((await entitiesOf(at(later.links).id)).map((e) => e.external_id)).toEqual([
        'it-setup-18',
        'it-setup-eng', // still there
        'it-setup-fin',
      ])
    })

    it('cannot blank a field by leaving it out or sending null', async () => {
      const first = await push({ primarySource: 'zeus', price: { value: 20.4, currency: 'EUR' } })
      const second = await push({ startsOn: null, endsOn: undefined, price: null })
      const third = await push({})

      expect(second.campaign.startsOn).toBe(first.campaign.startsOn)
      expect(second.campaign.endsOn).toBe(first.campaign.endsOn)
      expect(second.campaign.primarySource).toBe('zeus')
      expect(third.campaign.price).toEqual({ value: 20.4, currency: 'EUR' })
      expect(await storedPrice(first.campaign.id)).toEqual({ price: '20.4000', currency: 'EUR' })
    })

    it('changes the price a push states, such as a renegotiated one', async () => {
      const first = await push({ primarySource: 'zeus' })
      const priced = await push({ price: { value: 20.4, currency: 'EUR' } })
      const repriced = await push({ price: { value: 18.9, currency: 'CHF' } })

      expect(first.campaign.price).toBeNull()
      expect(priced.campaign.price).toEqual({ value: 20.4, currency: 'EUR' })
      expect(repriced.campaign.price).toEqual({ value: 18.9, currency: 'CHF' })
      expect(await storedPrice(first.campaign.id)).toEqual({ price: '18.9000', currency: 'CHF' })
    })

    it('writes nothing when the push changes nothing', async () => {
      const first = await push(
        { primarySource: 'zeus', price: { value: 20.4, currency: 'EUR' } },
        zeus(),
      )
      // The same price with its keys in the other order is the same price.
      const again = await push(
        { primarySource: 'zeus', price: { currency: 'EUR', value: 20.4 } },
        zeus(),
      )

      expect(again.campaign.updatedAt).toEqual(first.campaign.updatedAt)
      expect([again.created, again.updated]).toEqual([false, false])
      expect(at(again.links)).toMatchObject({ created: false, entitiesAdded: 0 })
    })

    it('corrects a link config, such as the wrong kind of Zeus id', async () => {
      const first = await push({ primarySource: 'zeus' }, zeus({ idType: 'external_id' }))
      await push({}, zeus({ idType: 'internal_id' }))

      const [link] = await db.query<{ config: { campaign_id_param: string } }>(
        'SELECT config FROM external.campaign_link WHERE id = $1',
        [at(first.links).id],
      )
      expect(link?.config.campaign_id_param).toBe('internal_id')
    })

    it('renames the company it knows by reference, and never moves a campaign to another', async () => {
      const first = await push({ primarySource: 'zeus' })

      const renamed = await push({
        company: {
          name: 'IT Setup Rauch AG',
          externalRef: { system: 'salesforce', id: 'it-setup-001' },
        },
      })
      expect(renamed.company).toMatchObject({ id: first.company.id, name: 'IT Setup Rauch AG' })

      await expect(
        push({
          company: {
            name: 'IT Setup Elsewhere',
            externalRef: { system: 'salesforce', id: 'it-setup-002' },
          },
        }),
      ).rejects.toMatchObject({ code: 'company_mismatch', status: 409 })
      // …and the company the refused push would have created was rolled back.
      expect(await db.query(`SELECT 1 FROM app.company WHERE name = 'IT Setup Elsewhere'`)).toEqual(
        [],
      )
    })

    it('accepts the company by name alone when it is the one the campaign already has', async () => {
      const first = await setUpCampaign(deps, setup({ externalRef: REF, primarySource: 'zeus' }))
      const second = await setUpCampaign(deps, setup({ externalRef: REF, name: 'IT Setup Again' }))

      expect(second.created).toBe(false)
      expect(second.company.id).toBe(first.company.id)
    })

    it('serialises two pushes of the same new record instead of creating twins', async () => {
      const results = await Promise.all([
        push({ primarySource: 'zeus' }),
        push({ primarySource: 'zeus' }),
      ])

      expect(results.map((r) => r.created).sort()).toEqual([false, true])
      expect(at(results).campaign.id).toBe(at(results, 1).campaign.id)
    })
  })

  describe('migration 0005_campaign_price', () => {
    // One statement, so a refused campaign takes its company with it.
    const insertCampaign = (price: string | null, currency: string | null) =>
      db.query(
        `WITH company AS (INSERT INTO app.company (name) VALUES ('IT Setup Raw') RETURNING id)
         INSERT INTO app.campaign (company_id, name, primary_source, price, currency)
         SELECT id, 'IT Setup Raw', 'zeus', $1::numeric, $2 FROM company`,
        [price, currency],
      )

    it('wants a price and its currency together, or neither', async () => {
      expect(await sqlstateOf(() => insertCampaign('20.4', null))).toBe('23514')
      expect(await sqlstateOf(() => insertCampaign(null, 'EUR'))).toBe('23514')
      expect(await sqlstateOf(() => insertCampaign(null, null))).toBeUndefined()
      expect(await sqlstateOf(() => insertCampaign('20.4', 'EUR'))).toBeUndefined()
    })

    it('wants a price of 0 or more and a currency code in capitals', async () => {
      expect(await sqlstateOf(() => insertCampaign('-0.01', 'EUR'))).toBe('23514')
      expect(await sqlstateOf(() => insertCampaign('20.4', 'eur'))).toBe('23514')
      expect(await sqlstateOf(() => insertCampaign('20.4', 'EURO'))).toBe('23514')
      expect(await sqlstateOf(() => insertCampaign('0', 'EUR'))).toBeUndefined()
    })
  })

  describe('migration 0004_external_refs', () => {
    const insertCompany = (system: string | null, id: string | null) =>
      db.query(
        `INSERT INTO app.company (name, external_system, external_id) VALUES ('IT Setup Raw', $1, $2)`,
        [system, id],
      )

    it('wants both halves of a reference or neither', async () => {
      expect(await sqlstateOf(() => insertCompany('salesforce', null))).toBe('23514')
      expect(await sqlstateOf(() => insertCompany(null, 'it-setup-x'))).toBe('23514')
      expect(await sqlstateOf(() => insertCompany(null, null))).toBeUndefined()
    })

    it('wants the system to be a slug and the id not to be empty', async () => {
      expect(await sqlstateOf(() => insertCompany('Sales Force', 'it-setup-x'))).toBe('23514')
      expect(await sqlstateOf(() => insertCompany('salesforce', ''))).toBe('23514')
    })

    it('allows a reference once, and any number of rows without one', async () => {
      expect(await sqlstateOf(() => insertCompany('salesforce', 'it-setup-x'))).toBeUndefined()
      expect(await sqlstateOf(() => insertCompany('salesforce', 'it-setup-x'))).toBe('23505')
      expect(await sqlstateOf(() => insertCompany('hubspot', 'it-setup-x'))).toBeUndefined()
      expect(await sqlstateOf(() => insertCompany(null, null))).toBeUndefined()
    })
  })
})
