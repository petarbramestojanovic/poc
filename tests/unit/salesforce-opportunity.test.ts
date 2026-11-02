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

/** Every column of the tab '2.11.2026' of "All Opportunities - BMS", flat as the tab has it. */
const flatRecord = (over: Record<string, unknown> = {}) => ({
  _: '[Opportunity]',
  Id: '006Aa00000BcDeFgHI',
  Name: 'AT2610 Alpenmilch App Launch',
  AccountId: '001Aa00000KlMnOpQR',
  Account: '[Account]',
  'Account.Name': 'Medien 7 Planung und -Einkauf GmbH',
  Amount: 7128.75,
  CurrencyIsoCode: 'EUR',
  Campaign_Start_Date__c: '2026-10-09',
  Campaign_End_Date__c: '2026-10-31',
  Country__c: 'Austria',
  Creative_Type__c: 'Reveal Ad;Swipe Card',
  N_N_Price__c: 14.2575,
  Owner: '[User]',
  'Owner.Name': 'Erika Beispiel',
  Type: 'Media Solutions',
  LastModifiedDate: '2026-10-11T22:00:16.000+0000',
  Campaign_Manager__c: '005Aa00000StUvWxYZ',
  Campaign_Manager__r: '[User]',
  'Campaign_Manager__r.Name': 'Max Muster',
  ...over,
})

/** The same record as REST JSON: the names inside their relationships. */
const nestedRecord = (over: Record<string, unknown> = {}) => {
  const {
    _: _label,
    'Account.Name': account,
    'Owner.Name': owner,
    'Campaign_Manager__r.Name': manager,
    ...fields
  } = flatRecord()
  return {
    attributes: { type: 'Opportunity', url: '/services/data/v66.0/sobjects/Opportunity/x' },
    ...fields,
    Account: { attributes: { type: 'Account' }, Name: account },
    Owner: { attributes: { type: 'User' }, Name: owner },
    Campaign_Manager__r: { attributes: { type: 'User' }, Name: manager },
    ...over,
  }
}

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
      amount: { value: 7128.75, currency: 'EUR' },
      dealType: 'Media Solutions',
      country: 'Austria',
      creativeTypes: ['Reveal Ad', 'Swipe Card'],
      ownerName: 'Erika Beispiel',
      externalModifiedAt: '2026-10-11T22:00:16.000Z',
      sources: [],
    })
  })

  it('ignores every field it does not map, whatever it holds', () => {
    const { setup, warnings } = setupOf({
      Description: 'x'.repeat(20_000),
      StageName: 'Committed (BMS)',
      Margin__c: { nested: 'hostile' },
    })
    const text = JSON.stringify(setup)
    for (const value of ['xxxx', 'Committed', 'hostile']) expect(text).not.toContain(value)
    expect(warnings).toEqual([])
    expect(Object.keys(setup).sort()).toEqual([
      'amount',
      'company',
      'country',
      'creativeTypes',
      'dealType',
      'endsOn',
      'externalModifiedAt',
      'externalRef',
      'name',
      'ownerName',
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
    const { setup, warnings } = setupOf({ Amount: null, ...over })
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

describe('a record with the fields of the sheet', () => {
  it.each([
    ['flat, as the sheet has it', flatRecord],
    ['nested, as REST JSON has it', nestedRecord],
  ])('sets up everything from it, %s', (_name, shaped) => {
    const outcome = toCampaignSetup(shaped())
    expect(outcome).toEqual({
      kind: 'setup',
      opportunityId: '006Aa00000BcDeFgHI',
      warnings: [],
      setup: {
        externalRef: { system: 'salesforce', id: '006Aa00000BcDeFgHI' },
        company: {
          name: 'Medien 7 Planung und -Einkauf GmbH',
          externalRef: { system: 'salesforce', id: '001Aa00000KlMnOpQR' },
        },
        name: 'AT2610 Alpenmilch App Launch',
        startsOn: '2026-10-09',
        endsOn: '2026-10-31',
        price: { value: 14.2575, currency: 'EUR' },
        amount: { value: 7128.75, currency: 'EUR' },
        dealType: 'Media Solutions',
        country: 'Austria',
        creativeTypes: ['Reveal Ad', 'Swipe Card'],
        ownerName: 'Erika Beispiel',
        manager: { id: '005Aa00000StUvWxYZ', name: 'Max Muster' },
        externalModifiedAt: '2026-10-11T22:00:16.000Z',
        sources: [],
      },
    })
  })

  it.each([
    [
      'flat',
      flatRecord({
        Campaign_Manager__c: null,
        Campaign_Manager__r: null,
        'Campaign_Manager__r.Name': null,
      }),
    ],
    ['nested', nestedRecord({ Campaign_Manager__c: null, Campaign_Manager__r: null })],
  ])('has no manager when the opportunity has none, and no warning for that: %s', (_name, sent) => {
    const outcome = toCampaignSetup(sent)
    expect(outcome).toMatchObject({ kind: 'setup', warnings: [] })
    expect(outcome.kind === 'setup' && outcome.setup).not.toHaveProperty('manager')
  })

  it.each([
    ['a blank flat name', flatRecord({ 'Account.Name': '  ' })],
    ['no flat name, only the label', flatRecord({ 'Account.Name': null })],
    ['a nested name that is not text', nestedRecord({ Account: { Name: 7654321 } })],
  ])('refuses %s for the account, naming the field and not the value', (_name, sent) => {
    const outcome = toCampaignSetup(sent)
    expect(outcome).toMatchObject({ kind: 'invalid', opportunityId: '006Aa00000BcDeFgHI' })
    const message = outcome.kind === 'invalid' ? outcome.message : ''
    expect(message).toContain('Account_Name__c')
    expect(message).not.toContain('7654321')
  })

  // Excel shows the sheet's dates this way. Day and month could be either way round, so a date in
  // this form is refused rather than read.
  it.each([
    ['Campaign_Start_Date__c', { Campaign_Start_Date__c: '11/2/2026' }],
    ['Campaign_End_Date__c', { Campaign_End_Date__c: '11/15/2026' }],
  ])('refuses %s as Excel shows it', (field, over) => {
    const outcome = toCampaignSetup(flatRecord(over))
    expect(outcome).toMatchObject({ kind: 'invalid' })
    expect(outcome.kind === 'invalid' && outcome.message).toContain(field)
  })
})

describe('what a record says about the deal', () => {
  const MANAGER = '005Aa00000StUvWxYZ'
  const noDeal = {
    Amount: null,
    Type: null,
    Country__c: null,
    Creative_Type__c: null,
    Owner_Name__c: null,
    LastModifiedDate: null,
  }

  it('reads the manager from a query: the id, and the name through the relationship', () => {
    const { setup, warnings } = setupOf({
      Campaign_Manager__c: MANAGER,
      Campaign_Manager__r: { attributes: { type: 'User' }, Name: 'Max Muster' },
    })
    expect(setup.manager).toEqual({ id: MANAGER, name: 'Max Muster' })
    expect(warnings).toEqual([])
  })

  it('takes the manager id alone, as the webhook sample has it', () => {
    const { setup, warnings } = setupOf({ Campaign_Manager__c: MANAGER })
    expect(setup.manager).toEqual({ id: MANAGER })
    expect(warnings).toEqual([])
  })

  it('reads a record whose names come through relationships, as a query returns them', () => {
    const { setup, warnings } = setupOf({
      Account_Name__c: undefined,
      Account: { attributes: { type: 'Account' }, Name: 'Medien 7 GmbH' },
      Owner_Name__c: undefined,
      Owner: { attributes: { type: 'User' }, Name: 'Erika Beispiel' },
    })
    expect(setup.company).toMatchObject({ name: 'Medien 7 GmbH' })
    expect(setup.ownerName).toBe('Erika Beispiel')
    expect(warnings).toEqual([])
  })

  it('prefers the fields of the record to the relationships', () => {
    const { setup } = setupOf({
      Account: { Name: 'Through The Relationship' },
      Owner: { Name: 'Through The Relationship' },
    })
    expect(setup.company).toMatchObject({ name: 'Medien 7 Planung und -Einkauf GmbH' })
    expect(setup.ownerName).toBe('Erika Beispiel')
  })

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['a label instead of a relationship', '[Account]'],
    ['a relationship without a name', { attributes: { type: 'Account' } }],
    ['a blank name', { Name: '  ' }],
    ['a name that is not text', { Name: 7654321 }],
  ])('refuses a record with no account name and %s in Account', (_name, Account) => {
    const { message } = refusalOf({ Account_Name__c: undefined, Account })
    expect(message).toContain('Account_Name__c')
  })

  it('splits the creative types and keeps each one once', () => {
    const { setup } = setupOf({ Creative_Type__c: 'Catcher;Reveal Ad; Catcher ;;' })
    expect(setup.creativeTypes).toEqual(['Catcher', 'Reveal Ad'])
  })

  it('keeps an amount of 0, which is what the record says, not "not known"', () => {
    const { setup, warnings } = setupOf({ Amount: 0 })
    expect(setup.amount).toEqual({ value: 0, currency: 'EUR' })
    expect(warnings).toEqual([])
  })

  it.each([
    ['2026-10-11T22:00:16.000+0000', '2026-10-11T22:00:16.000Z'],
    ['2026-10-11T22:00:16.000+0200', '2026-10-11T20:00:16.000Z'],
    ['2026-10-11T22:00:16.000+00:00', '2026-10-11T22:00:16.000Z'],
    ['2026-10-11T22:00:16Z', '2026-10-11T22:00:16.000Z'],
  ])('reads %s as one instant', (LastModifiedDate, instant) => {
    expect(setupOf({ LastModifiedDate }).setup.externalModifiedAt).toBe(instant)
  })

  it('leaves all of it out when the record says nothing, and warns about none of it', () => {
    const { setup, warnings } = setupOf(noDeal)
    for (const field of [
      'amount',
      'dealType',
      'country',
      'creativeTypes',
      'ownerName',
      'manager',
      'externalModifiedAt',
    ]) {
      expect(setup).not.toHaveProperty(field)
    }
    expect(warnings).toEqual([])
  })

  // None of this decides anything, so none of it may cost the campaign, and a warning goes back to
  // the sender: it names the field, never the value.
  it.each<[string, Record<string, unknown>, string, string]>([
    ['a third decimal', { Amount: 7128.755 }, 'Amount', '7128.755'],
    ['a negative amount', { Amount: -5 }, 'Amount', '-5'],
    ['an amount too large for the column', { Amount: 1e13 }, 'Amount', '1000000'],
    ['an amount as text', { Amount: 'Erika owes 7128' }, 'Amount', 'Erika owes'],
    ['a type that is not text', { Type: { hostile: 'Erika' } }, 'Type', 'hostile'],
    ['a country that is not text', { Country__c: 7654321 }, 'Country__c', '7654321'],
    [
      'creative types that are not text',
      { Creative_Type__c: 7654321 },
      'Creative_Type__c',
      '7654321',
    ],
    ['creative types that are empty', { Creative_Type__c: ' ; ' }, 'Creative_Type__c', ';'],
    ['an owner that is not text', { Owner_Name__c: 7654321 }, 'Owner_Name__c', '7654321'],
    ['a time that is no time', { LastModifiedDate: 'gestern' }, 'LastModifiedDate', 'gestern'],
    [
      'an impossible date',
      { LastModifiedDate: '2026-02-31T10:00:00.000+0000' },
      'LastModifiedDate',
      '2026-02-31',
    ],
    [
      'a manager id that is a name',
      { Campaign_Manager__c: 'Max Muster' },
      'Campaign_Manager__c',
      'Max Muster',
    ],
    [
      'the 15-character form of the manager id',
      { Campaign_Manager__c: '005Aa00000StUvW' },
      'Campaign_Manager__c',
      '005Aa00000StUvW',
    ],
  ])('leaves out %s with a warning, and sets the campaign up', (_name, over, field, value) => {
    const { setup, warnings } = setupOf(over)
    expect(setup.name).toBe('AT2610 Alpenmilch App Launch')
    expect(warnings).toEqual([expect.stringContaining(field)])
    expect(warnings[0]).not.toContain(value)
    expect(JSON.stringify(setup)).not.toContain(value)
  })

  it('leaves out an amount without a currency, and the price with it', () => {
    const { setup, warnings } = setupOf({ CurrencyIsoCode: null })
    expect(setup.amount).toBeUndefined()
    expect(setup.price).toBeUndefined()
    expect(warnings).toEqual([
      expect.stringContaining('N_N_Price__c'),
      expect.stringContaining('Amount without a CurrencyIsoCode'),
    ])
  })

  it('leaves out a manager name with no usable id: a name alone identifies nobody', () => {
    const { setup, warnings } = setupOf({ Campaign_Manager__r: { Name: 'Max Muster' } })
    expect(setup.manager).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('no usable Campaign_Manager__c')])
    expect(warnings[0]).not.toContain('Max Muster')
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
