import { describe, expect, it } from 'vitest'
import {
  committedOppsReportSchema,
  companyKey,
  languageCodes,
  toCampaignSetup,
} from '../../src/salesforce/report.ts'

// The daily Salesforce report, row by row: what becomes a campaign, what is ignored, what refuses
// a row. Shaped like the real export of 2026-10-06; every name and number here is made up.

const row = (over: Record<string, unknown> = {}) => ({
  opportunity_owner: 'Erika Beispiel',
  opportunity_name: 'AT2610 Alpenmilch App Launch',
  opportunity_id: '006Aa00000BcDeFgHI',
  account_name: 'Medien 7 Planung und -Einkauf GmbH',
  currency: 'EUR',
  amount: 10000,
  billing_country: 'Austria',
  campaign_start_date: '2026-10-09',
  campaign_end_date: '2026-10-31',
  creative_languages: 'German',
  nn_price: 14.2575,
  billing_type: 'CPM',
  targeting: 'A18-49\r\nGEO: Vorarlberg',
  whitelisted: null,
  blacklisted: null,
  deliverables: 500000,
  campaign_manager: 'Max Muster',
  ...over,
})

const setupOf = (over: Record<string, unknown> = {}) => {
  const outcome = toCampaignSetup(row(over))
  if (!outcome.ok) throw new Error(`expected a setup, got: ${outcome.message}`)
  return outcome
}

describe('a report row', () => {
  it('becomes a campaign of the account, keyed by the opportunity id', () => {
    const { setup, warnings, opportunityId } = setupOf()
    expect(opportunityId).toBe('006Aa00000BcDeFgHI')
    expect(warnings).toEqual([])
    expect(setup).toEqual({
      externalRef: { system: 'salesforce', id: '006Aa00000BcDeFgHI' },
      company: {
        name: 'Medien 7 Planung und -Einkauf GmbH',
        externalRef: { system: 'salesforce', id: 'medien_7_planung_und_einkauf_gmbh' },
      },
      name: 'AT2610 Alpenmilch App Launch',
      startsOn: '2026-10-09',
      endsOn: '2026-10-31',
      languages: ['de'],
      price: { value: 14.2575, currency: 'EUR' },
      sources: [],
    })
  })

  it('ignores every field it does not map, however long', () => {
    const { setup } = setupOf({ targeting: 'x'.repeat(20_000), amount: 'not a number' })
    expect(JSON.stringify(setup)).not.toContain('xxxx')
    expect(Object.keys(setup).sort()).toEqual([
      'company',
      'endsOn',
      'externalRef',
      'languages',
      'name',
      'price',
      'sources',
      'startsOn',
    ])
  })

  it.each([
    ['CPC', 'CPC', 0.5],
    ['no billing type', null, 11.5235],
  ])('takes nn_price as the CPM even with %s', (_name, billingType, price) => {
    const { setup } = setupOf({ billing_type: billingType, nn_price: price })
    expect(setup.price).toEqual({ value: price, currency: 'EUR' })
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['without nn_price', { nn_price: null }, 'no nn_price'],
    ['without a currency', { currency: null }, 'without a currency'],
    ['with a fifth decimal', { nn_price: 14.25751 }, '4 decimal places'],
    ['with a currency that is not one', { currency: 'EUX' }, 'ISO 4217'],
  ])('is still set up %s, with no price and a warning', (_name, over, warning) => {
    const { setup, warnings } = setupOf(over)
    expect(setup.price).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining(warning)])
  })

  it('reads a lower-case currency', () => {
    expect(setupOf({ currency: 'chf' }).setup.price).toEqual({ value: 14.2575, currency: 'CHF' })
  })

  it('leaves out what it does not state, so a push cannot clear it', () => {
    const { setup } = setupOf({
      campaign_start_date: null,
      campaign_end_date: undefined,
      creative_languages: null,
    })
    expect(setup).not.toHaveProperty('startsOn')
    expect(setup).not.toHaveProperty('endsOn')
    expect(setup).not.toHaveProperty('languages')
  })

  it.each<[string, Record<string, unknown>, string | null, string]>([
    [
      'an end before its start',
      { campaign_start_date: '2026-10-31', campaign_end_date: '2026-10-01' },
      '006Aa00000BcDeFgHI',
      'endsOn is before startsOn',
    ],
    [
      'an impossible date',
      { campaign_start_date: '2026-02-31' },
      '006Aa00000BcDeFgHI',
      'campaign_start_date',
    ],
    ['no account', { account_name: '  ' }, '006Aa00000BcDeFgHI', 'account_name'],
    [
      'an account with nothing to key it by',
      { account_name: '— & —' },
      '006Aa00000BcDeFgHI',
      'company id',
    ],
    ['no opportunity name', { opportunity_name: null }, '006Aa00000BcDeFgHI', 'opportunity_name'],
    [
      'an id that is not an opportunity',
      { opportunity_id: '001Aa00000BcDeFgHI' },
      null,
      'opportunity id',
    ],
    ['an id of the wrong length', { opportunity_id: '006Aa00000BcDe' }, null, 'opportunity id'],
  ])('is refused with %s', (_name, over, opportunityId, message) => {
    const outcome = toCampaignSetup(row(over))
    expect(outcome).toMatchObject({ ok: false, opportunityId })
    expect(!outcome.ok && outcome.message).toContain(message)
  })

  it('names the field of a refusal, never its value', () => {
    const outcome = toCampaignSetup(row({ nn_price: '14.2575', campaign_end_date: 'Oct 31' }))
    expect(outcome.ok).toBe(false)
    const message = !outcome.ok ? outcome.message : ''
    expect(message).toContain('nn_price')
    expect(message).not.toContain('14.2575')
    expect(message).not.toContain('Oct 31')
  })

  it('refuses something that is not a row at all', () => {
    expect(toCampaignSetup(null)).toMatchObject({ ok: false, opportunityId: null })
    expect(toCampaignSetup('row')).toMatchObject({ ok: false, opportunityId: null })
  })
})

describe('the company id', () => {
  it.each([
    ['Medien 7 Planung und -Einkauf GmbH', 'medien_7_planung_und_einkauf_gmbh'],
    ['Werbeplus Austria GmbH & Co. KG', 'werbeplus_austria_gmbh_co_kg'],
    [
      'Schloß Grünberg Kultur- u. Betriebsges.m.b.H.',
      'schloss_gruenberg_kultur_u_betriebsges_m_b_h',
    ],
    ['Kaffeerösterei GmbH', 'kaffeeroesterei_gmbh'],
    ['  ÜBER Café — Zürich  ', 'ueber_cafe_zuerich'],
    ['Seetaler Kantonalbank', 'seetaler_kantonalbank'],
  ])('of %s is %s', (name, key) => {
    expect(companyKey(name)).toBe(key)
  })

  it('is the same for names that differ only in case and punctuation', () => {
    expect(companyKey('Nordlicht Media GmbH')).toBe(companyKey('NORDLICHT MEDIA, GmbH.'))
  })
})

describe('creative languages', () => {
  it.each<[string | null, string[], string[]]>([
    ['German', ['de'], []],
    ['German;French', ['de', 'fr'], []],
    ['german, Italian; German', ['de', 'it'], []],
    ['German; Klingon', ['de'], ['Klingon']],
    [null, [], []],
    ['', [], []],
  ])('%j → %j', (value, codes, unknown) => {
    expect(languageCodes(value)).toEqual({ codes, unknown })
  })

  it('warns about a language it does not know and keeps the rest', () => {
    const { setup, warnings } = setupOf({ creative_languages: 'German; Klingon' })
    expect(setup.languages).toEqual(['de'])
    expect(warnings).toEqual([expect.stringContaining('Klingon')])
  })
})

describe('the report envelope', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    source: 'salesforce_report',
    report_name: 'Media Solutions - Committed Opps - Daily',
    report_as_of: '2026-10-06T06:00:03',
    report_timezone: 'Europe/Zurich',
    snapshot: true,
    record_count: 2,
    email: { subject: 'FW: Report results' },
    unmapped_columns: [],
    campaigns: [row(), row({ opportunity_id: '006Aa00000BcDeJkLM' })],
    ...over,
  })

  it('accepts the report as it is sent, extra fields and all', () => {
    const parsed = committedOppsReportSchema.parse(report({ unmapped_columns: undefined }))
    expect(parsed.campaigns).toHaveLength(2)
    expect(parsed.unmapped_columns).toEqual([])
  })

  it.each<[string, Record<string, unknown>]>([
    ['another source', { source: 'hubspot' }],
    ['a count that disagrees with the rows', { record_count: 3 }],
    ['no campaigns', { campaigns: undefined }],
    ['campaigns that are not a list', { campaigns: {} }],
  ])('refuses %s', (_name, over) => {
    expect(committedOppsReportSchema.safeParse(report(over)).success).toBe(false)
  })

  it('accepts an empty report', () => {
    expect(
      committedOppsReportSchema.safeParse(report({ record_count: 0, campaigns: [] })).success,
    ).toBe(true)
  })
})
