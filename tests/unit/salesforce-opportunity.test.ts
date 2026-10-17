import { describe, expect, it } from 'vitest'
import {
  INGEST_FROM,
  languageCodes,
  opportunityDeliverySchema,
  recordsOf,
  toCampaignSetup,
} from '../../src/modules/salesforce/opportunity.ts'

// Salesforce's Opportunity webhook, record by record: what becomes a campaign, what is ignored,
// what refuses a record. Shaped like the sample of 2026-10-12 ("Webhook Fields - Opportunity BMS");
// every name, id and number here is made up.

const record = (over: Record<string, unknown> = {}) => ({
  attributes: {
    type: 'Opportunity',
    url: '/services/data/v66.0/sobjects/Opportunity/006Aa00000BcDeFgHI',
  },
  Id: '006Aa00000BcDeFgHI',
  AccountId: '001Aa00000KlMnOpQR',
  Name: 'AT2610 Alpenmilch App Launch',
  Amount: 7128.75,
  Type: 'Media Solutions',
  CurrencyIsoCode: 'EUR',
  LastModifiedDate: '2026-10-11T22:00:16.000+0000',
  Owner_Name__c: 'Erika Beispiel',
  Account_Name__c: 'Medien 7 Planung und -Einkauf GmbH',
  N_N_Price__c: 14.2575,
  Campaign_Start_Date__c: '2026-10-09',
  Campaign_End_Date__c: '2026-10-31',
  Country__c: 'Austria',
  Creative_Type__c: 'Reveal Ad;Swipe Card',
  ...over,
})

const setupOf = (over: Record<string, unknown> = {}) => {
  const outcome = toCampaignSetup(record(over))
  if (outcome.kind !== 'setup') throw new Error(`expected a setup, got: ${JSON.stringify(outcome)}`)
  return outcome
}

/** The message of a refused record, or a failure when it was not refused. */
const refusalOf = (over: Record<string, unknown>) => {
  const outcome = toCampaignSetup(record(over))
  if (outcome.kind !== 'invalid') throw new Error(`expected a refusal, got: ${outcome.kind}`)
  return outcome
}

describe('an Opportunity record', () => {
  it('becomes a campaign of its account, both keyed by their Salesforce ids', () => {
    const { setup, warnings, opportunityId } = setupOf()
    expect(opportunityId).toBe('006Aa00000BcDeFgHI')
    expect(warnings).toEqual([])
    expect(setup).toEqual({
      externalRef: { system: 'salesforce', id: '006Aa00000BcDeFgHI' },
      company: {
        name: 'Medien 7 Planung und -Einkauf GmbH',
        externalRef: { system: 'salesforce', id: '001Aa00000KlMnOpQR' },
      },
      name: 'AT2610 Alpenmilch App Launch',
      startsOn: '2026-10-09',
      endsOn: '2026-10-31',
      price: { value: 14.2575, currency: 'EUR' },
      sources: [],
    })
  })

  it('ignores every field it does not map, whatever it holds', () => {
    const { setup } = setupOf({
      Description: 'x'.repeat(20_000),
      Amount: 'not a number',
      Type: 'Something Else',
      LastModifiedDate: 'yesterday',
    })
    const text = JSON.stringify(setup)
    for (const value of ['xxxx', 'Erika', 'Austria', 'Reveal Ad', 'Something Else', '7128']) {
      expect(text).not.toContain(value)
    }
    expect(Object.keys(setup).sort()).toEqual([
      'company',
      'endsOn',
      'externalRef',
      'name',
      'price',
      'sources',
      'startsOn',
    ])
  })

  it('reads Creative_Languages__c when the sender includes it', () => {
    const { setup, warnings } = setupOf({ Creative_Languages__c: 'German;French' })
    expect(setup.languages).toEqual(['de', 'fr'])
    expect(warnings).toEqual([])
  })

  it('warns about a language it does not know and keeps the rest', () => {
    const { setup, warnings } = setupOf({ Creative_Languages__c: 'German;Klingon' })
    expect(setup.languages).toEqual(['de'])
    expect(warnings).toEqual([expect.stringContaining('Klingon')])
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['without N_N_Price__c', { N_N_Price__c: null }, 'no N_N_Price__c'],
    ['without a currency', { CurrencyIsoCode: null }, 'without a CurrencyIsoCode'],
    ['with a seventh decimal', { N_N_Price__c: 14.2575012 }, '6 decimal places'],
    ['with a currency that is not one', { CurrencyIsoCode: 'EUX' }, 'ISO 4217'],
  ])('is still set up %s, with no price and a warning', (_name, over, warning) => {
    const { setup, warnings } = setupOf(over)
    expect(setup.price).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining(warning)])
  })

  it.each([0.39525, 5.31686, 14.257501])('keeps a price of %s exactly', (value) => {
    const { setup, warnings } = setupOf({ N_N_Price__c: value })
    expect(setup.price).toEqual({ value, currency: 'EUR' })
    expect(warnings).toEqual([])
  })

  it('reads a lower-case currency', () => {
    expect(setupOf({ CurrencyIsoCode: 'chf' }).setup.price).toEqual({
      value: 14.2575,
      currency: 'CHF',
    })
  })

  it('leaves out what it does not state, so a push cannot clear it', () => {
    const { setup } = setupOf({ Campaign_End_Date__c: undefined, Creative_Languages__c: null })
    expect(setup).not.toHaveProperty('endsOn')
    expect(setup).not.toHaveProperty('languages')
  })

  it('keys the company by the account id alone and keeps its name exactly', () => {
    const name = 'Schloß Grünberg Kultur- u. Betriebsges.m.b.H.'
    const { setup } = setupOf({ Account_Name__c: name })
    expect(setup.company).toEqual({
      name,
      externalRef: { system: 'salesforce', id: '001Aa00000KlMnOpQR' },
    })
  })

  it.each<[string, Record<string, unknown>, string | null, string]>([
    [
      'an end before its start',
      { Campaign_Start_Date__c: '2026-10-31', Campaign_End_Date__c: '2026-10-01' },
      '006Aa00000BcDeFgHI',
      'endsOn is before startsOn',
    ],
    [
      'an impossible date',
      { Campaign_Start_Date__c: '2026-02-31' },
      '006Aa00000BcDeFgHI',
      'Campaign_Start_Date__c',
    ],
    [
      'a date with a time',
      { Campaign_End_Date__c: '2026-10-31T00:00:00.000+0000' },
      '006Aa00000BcDeFgHI',
      'Campaign_End_Date__c',
    ],
    ['no account name', { Account_Name__c: '  ' }, '006Aa00000BcDeFgHI', 'Account_Name__c'],
    ['no account id', { AccountId: null }, '006Aa00000BcDeFgHI', 'AccountId'],
    [
      'an account id that is not an account',
      { AccountId: '003Aa00000KlMnOpQR' },
      '006Aa00000BcDeFgHI',
      'account id',
    ],
    [
      'the 15-character form of the account id',
      { AccountId: '001Aa00000KlMnO' },
      '006Aa00000BcDeFgHI',
      'AccountId',
    ],
    ['no opportunity name', { Name: null }, '006Aa00000BcDeFgHI', 'Name'],
    ['an id that is not an opportunity', { Id: '001Aa00000BcDeFgHI' }, null, 'opportunity id'],
    // Another spelling of the same record would become a second campaign.
    ['the 15-character form of the id', { Id: '006Aa00000BcDeF' }, null, 'opportunity id'],
  ])('is refused with %s', (_name, over, opportunityId, message) => {
    const outcome = refusalOf(over)
    expect(outcome.opportunityId).toBe(opportunityId)
    expect(outcome.message).toContain(message)
  })

  it('names the field of a refusal, never its value', () => {
    const { message } = refusalOf({ N_N_Price__c: '14.2575', Campaign_End_Date__c: 'Oct 31' })
    expect(message).toContain('N_N_Price__c')
    expect(message).not.toContain('14.2575')
    expect(message).not.toContain('Oct 31')
  })

  it('refuses something that is not a record at all', () => {
    expect(toCampaignSetup(null)).toMatchObject({ kind: 'invalid', opportunityId: null })
    expect(toCampaignSetup('record')).toMatchObject({ kind: 'invalid', opportunityId: null })
  })
})

describe('the start date cut-off', () => {
  it('is the first day of 2026', () => {
    expect(INGEST_FROM).toBe('2026-01-01')
  })

  it.each(['2026-01-01', '2026-01-02', '2026-10-31'])('takes a campaign starting %s', (day) => {
    expect(setupOf({ Campaign_Start_Date__c: day }).setup.startsOn).toBe(day)
  })

  it.each<[string, unknown, string]>([
    ['the day before', '2025-12-31', 'before 2026-01-01'],
    ['a year before', '2025-03-03', 'before 2026-01-01'],
    ['no start date', null, 'no Campaign_Start_Date__c'],
    ['an absent start date', undefined, 'no Campaign_Start_Date__c'],
  ])('skips a campaign with %s, naming it', (_name, day, reason) => {
    expect(toCampaignSetup(record({ Campaign_Start_Date__c: day }))).toEqual({
      kind: 'skipped',
      opportunityId: '006Aa00000BcDeFgHI',
      reason: expect.stringContaining(reason) as string,
    })
  })

  it('skips an old campaign before looking at the rest of the record', () => {
    const old = record({ Campaign_Start_Date__c: '2025-06-01', AccountId: null, Name: null })
    expect(toCampaignSetup(old)).toMatchObject({ kind: 'skipped' })
  })

  it('refuses a start date it cannot read rather than skip it', () => {
    expect(refusalOf({ Campaign_Start_Date__c: '01.01.2026' }).message).toContain(
      'Campaign_Start_Date__c',
    )
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
})

describe('a delivery', () => {
  it('is a list of records, as in the sample', () => {
    const body = opportunityDeliverySchema.parse([record(), record({ Id: '006Aa00000BcDeJkLM' })])
    expect(recordsOf(body)).toHaveLength(2)
  })

  it('or one record on its own', () => {
    const body = opportunityDeliverySchema.parse(record())
    expect(recordsOf(body)).toEqual([record()])
  })

  it('may be empty', () => {
    expect(recordsOf(opportunityDeliverySchema.parse([]))).toEqual([])
  })

  it.each<[string, unknown]>([
    ['text', 'record'],
    ['a number', 7],
    ['null', null],
    ['more than 200 records', Array.from({ length: 201 }, () => ({}))],
  ])('is refused as %s', (_name, body) => {
    expect(opportunityDeliverySchema.safeParse(body).success).toBe(false)
  })
})
