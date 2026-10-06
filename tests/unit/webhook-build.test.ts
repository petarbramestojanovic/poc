import { describe, expect, it } from 'vitest'
import { buildPayload } from '../../src/webhooks/build.ts'
import { PayloadContractError } from '../../src/webhooks/errors.ts'
import {
  compileFields,
  payloadFieldsSchema,
  type PayloadFieldsInput,
} from '../../src/webhooks/fields.ts'
import { at } from '../helpers.ts'
import { fakeDb, type Respond } from './webhook-fakes.ts'

// buildPayload's own decisions: which extra reads a field list costs, when a source block is added
// for a formula, and refusing to shape a body the contract does not recognise.

const WEBHOOK = { id: '00000000-0000-4000-8000-0000000009b0', includeCreatives: true }
const CAMPAIGN = '00000000-0000-4000-8000-000000000002'
const PERIOD = { from: '2026-09-07', to: '2026-09-13' }

const block = (source: string, role: 'primary' | 'check') => ({
  source,
  display_name: source,
  role,
  day_timezone: 'UTC',
  data_complete_through: '2026-09-13',
  last_synced_at: null,
  metrics_available: ['impressions'],
  totals: { impressions: 1000 },
  daily: [],
  creatives: [],
  ctas: [],
  pages: [],
})

const body = (sources: unknown[]) => ({
  version: 1,
  delivery_id: null,
  generated_at: '2026-09-14T06:00:02Z',
  period: {
    start: PERIOD.from,
    end: PERIOD.to,
    timezone: 'Europe/Zurich',
    window: 'previous_week',
  },
  company: { id: '00000000-0000-4000-8000-000000000001', name: 'Dev Company' },
  campaigns: [{ id: CAMPAIGN, name: 'Dev', primary_source: 'nexd', sources }],
})

const fields = (input: PayloadFieldsInput) => compileFields(payloadFieldsSchema.parse(input))

function database(built: unknown, extra: Respond = () => []) {
  return fakeDb((text, params) => {
    if (text.includes('app.build_webhook_payload')) return [{ payload: built }]
    return extra(text, params)
  })
}

describe('buildPayload', () => {
  it('returns the body Postgres built, untouched, without a field list', async () => {
    const built = { anything: 'as built' }
    const db = database(built)
    expect(await buildPayload(db.db, WEBHOOK, PERIOD, null)).toBe(built)
    expect(db.queries).toHaveLength(1)
  })

  it('reads neither prices nor clicks when no formula needs them', async () => {
    const db = database(body([block('nexd', 'primary'), block('zeus', 'check')]))
    await buildPayload(
      db.db,
      WEBHOOK,
      PERIOD,
      fields({ calculated: [{ name: 'half', formula: 'impressions / 2' }] }),
    )
    expect(db.queries.map((query) => query.text)).toHaveLength(1)
  })

  it('reads the prices and the clicks a formula needs, for the sources that use them', async () => {
    const db = database(body([block('nexd', 'primary'), block('zeus', 'check')]))
    await buildPayload(
      db.db,
      WEBHOOK,
      PERIOD,
      fields({
        calculated: [
          { name: 'cost', formula: 'impressions / 1000 * price' },
          { name: 'ctr', formula: 'clicks / impressions', source: 'nexd' },
        ],
      }),
    )
    expect(at(db.matching('price::text')).params).toEqual([[CAMPAIGN]])
    expect(at(db.matching('FROM analytics.cta_clicks')).params).toEqual([
      [CAMPAIGN],
      ['nexd'],
      PERIOD.from,
      PERIOD.to,
    ])
  })

  it('adds the block a formula needs where the campaign is linked, as a check, in order', async () => {
    const db = database(body([block('nexd', 'primary')]), (text) => {
      if (text.includes('FROM external.campaign_link')) {
        return [{ campaign_id: CAMPAIGN, source_id: 'zeus' }]
      }
      if (text.includes('app.webhook_source_block')) return [{ block: block('zeus', 'check') }]
      return []
    })

    const shaped = (await buildPayload(
      db.db,
      WEBHOOK,
      PERIOD,
      fields({ calculated: [{ name: 'half', formula: 'impressions / 2' }] }),
    )) as { campaigns: { sources: { source: string; totals: Record<string, unknown> }[] }[] }

    expect(at(db.matching('app.webhook_source_block')).params).toEqual([
      CAMPAIGN,
      'zeus',
      PERIOD.from,
      PERIOD.to,
      true,
    ])
    const sources = at(shaped.campaigns).sources
    expect(sources.map((entry) => entry.source)).toEqual(['nexd', 'zeus'])
    expect(at(sources, 1).totals.half).toBe(500)
  })

  it('adds no block for a source the campaign is not linked to', async () => {
    const db = database(body([block('nexd', 'primary')]))
    await buildPayload(
      db.db,
      WEBHOOK,
      PERIOD,
      fields({ calculated: [{ name: 'half', formula: 'impressions / 2' }] }),
    )
    expect(db.matching('app.webhook_source_block')).toEqual([])
  })

  it('refuses to shape a body the contract does not recognise', async () => {
    const db = database({ ...body([block('zeus', 'primary')]), version: 2 })
    await expect(
      buildPayload(db.db, WEBHOOK, PERIOD, fields({ metrics: ['impressions'] })),
    ).rejects.toBeInstanceOf(PayloadContractError)
  })

  it('refuses an added block the contract does not recognise', async () => {
    const db = database(body([block('nexd', 'primary')]), (text) => {
      if (text.includes('FROM external.campaign_link')) {
        return [{ campaign_id: CAMPAIGN, source_id: 'zeus' }]
      }
      if (text.includes('app.webhook_source_block')) return [{ block: { source: 'zeus' } }]
      return []
    })
    await expect(
      buildPayload(
        db.db,
        WEBHOOK,
        PERIOD,
        fields({ calculated: [{ name: 'half', formula: 'impressions / 2' }] }),
      ),
    ).rejects.toMatchObject({ code: 'payload_contract', status: 500 })
  })
})
