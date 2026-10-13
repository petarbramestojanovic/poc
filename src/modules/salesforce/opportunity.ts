import { z } from 'zod'
import {
  campaignSetupSchema,
  priceSchema,
  type CampaignSetup,
  type Price,
} from '../campaigns/input.ts'

// Salesforce's webhook of "Opportunity (BMS)" records, as Salesforce itself posts them to
// POST /inbound/salesforce/opportunities (its REST JSON: API field names, an `attributes` block),
// and how one record becomes a CampaignSetup. Pure: no I/O. Salesforce's field names stop at this
// file.
//
// A record arrives whenever the opportunity is committed or changed. Only campaigns starting on or
// after INGEST_FROM are taken in; the rest are skipped. One that never arrives again
// means nothing, so a push only ever creates or updates. Of a record, only the fields in
// recordSchema are read; the rest (Amount, Type, owner, country, creative type, LastModifiedDate …)
// is ignored and never stored.

/** externalRef.system of the campaigns and companies this webhook creates. */
export const REF_SYSTEM = 'salesforce'

/**
 * Records in one delivery: Salesforce hands a trigger at most 200 at a time. Each one is about
 * 10 KB when the sender sends every field, so the route's body limit is 4 MiB.
 */
export const MAX_RECORDS = 200

/**
 * One Opportunity or a list of them. Records are checked one by one, in toCampaignSetup, so one
 * bad record never refuses the others.
 */
export const opportunityDeliverySchema = z.union([
  z.array(z.unknown()).max(MAX_RECORDS),
  z.looseObject({}),
])
export type OpportunityDelivery = z.infer<typeof opportunityDeliverySchema>

/** The records of a delivery, in the order they came. */
export const recordsOf = (delivery: OpportunityDelivery): unknown[] =>
  Array.isArray(delivery) ? delivery : [delivery]

/**
 * An 18-character Salesforce id with its key prefix (006 an opportunity, 001 an account). Never
 * the 15-character form: the same record under two spellings would become two campaigns.
 */
const salesforceId = (prefix: string, what: string) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^${prefix}[0-9A-Za-z]{15}$`), `not an 18-character Salesforce ${what} id`)

const opportunityId = salesforceId('006', 'opportunity')

/**
 * The first campaign start taken in. A campaign starting earlier, or with no start date, is
 * skipped whatever else the record says: it is neither set up nor updated, and not an error.
 */
export const INGEST_FROM = '2026-01-01'

const startSchema = z.looseObject({ Campaign_Start_Date__c: z.iso.date().nullish() })

const recordSchema = z.looseObject({
  Id: opportunityId,
  Name: z.string().trim().min(1).max(200),
  AccountId: salesforceId('001', 'account'),
  Account_Name__c: z.string().trim().min(1).max(200),
  CurrencyIsoCode: z.string().trim().nullish(),
  Campaign_Start_Date__c: z.iso.date(),
  Campaign_End_Date__c: z.iso.date().nullish(),
  /** Not among the fields the webhook promises; read when it comes. */
  Creative_Languages__c: z.string().nullish(),
  /** The CPM the campaign is sold at. Always a CPM, whatever the billing type says. */
  N_N_Price__c: z.number().nullish(),
})

export type RecordOutcome =
  | { kind: 'setup'; opportunityId: string; setup: CampaignSetup; warnings: string[] }
  | { kind: 'skipped'; opportunityId: string | null; reason: string }
  | { kind: 'invalid'; opportunityId: string | null; message: string }

/**
 * One Opportunity record as a CampaignSetup, why it is skipped, or why it cannot be one. The start
 * date is looked at first, so a record before INGEST_FROM is skipped even if the rest of it would
 * be refused. Never throws.
 */
export function toCampaignSetup(record: unknown): RecordOutcome {
  const start = startSchema.safeParse(record)
  if (!start.success) {
    return { kind: 'invalid', opportunityId: idOf(record), message: describe(start.error) }
  }
  const startsOn = start.data.Campaign_Start_Date__c
  if (!startsOn) {
    return { kind: 'skipped', opportunityId: idOf(record), reason: 'no Campaign_Start_Date__c' }
  }
  if (startsOn < INGEST_FROM) {
    return {
      kind: 'skipped',
      opportunityId: idOf(record),
      reason: `Campaign_Start_Date__c is before ${INGEST_FROM}`,
    }
  }

  const parsed = recordSchema.safeParse(record)
  if (!parsed.success) {
    return { kind: 'invalid', opportunityId: idOf(record), message: describe(parsed.error) }
  }
  const opp = parsed.data
  const warnings: string[] = []

  const languages = languageCodes(opp.Creative_Languages__c)
  if (languages.unknown.length > 0) {
    warnings.push(`Creative_Languages__c not recognised, left out: ${languages.unknown.join(', ')}`)
  }

  const price = toPrice(opp.N_N_Price__c, opp.CurrencyIsoCode)
  if (price.warning !== undefined) warnings.push(price.warning)

  // The key the daily report gave this account before the webhook carried its id.
  const formerKey = companyKey(opp.Account_Name__c)

  const setup = campaignSetupSchema.safeParse({
    externalRef: { system: REF_SYSTEM, id: opp.Id },
    company: {
      name: opp.Account_Name__c,
      externalRef: { system: REF_SYSTEM, id: opp.AccountId },
      ...(formerKey === '' ? {} : { formerRef: { system: REF_SYSTEM, id: formerKey } }),
    },
    // The name as sold, market and month prefix included ('AT2610 Alpenmilch App Launch').
    name: opp.Name,
    startsOn: opp.Campaign_Start_Date__c,
    // Left out rather than null: a push never clears what it does not state.
    ...(opp.Campaign_End_Date__c ? { endsOn: opp.Campaign_End_Date__c } : {}),
    ...(languages.codes.length > 0 ? { languages: languages.codes } : {}),
    ...(price.value === undefined ? {} : { price: price.value }),
  })
  if (!setup.success) {
    return { kind: 'invalid', opportunityId: opp.Id, message: describe(setup.error) }
  }
  return { kind: 'setup', opportunityId: opp.Id, setup: setup.data, warnings }
}

const SPELLED_OUT: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }

/**
 * The id the daily report (before 2026-10-13) gave a company, made from the account name because
 * that report had no account id: lowercase, German umlauts spelled out, other accents dropped,
 * every run of anything else one '_'. 'Schloß Grünberg Kultur- u. Betriebsges.m.b.H.' →
 * 'schloss_gruenberg_kultur_u_betriebsges_m_b_h'. Used only as `formerRef`, so a company the report
 * created moves to its account id the first time the webhook names it; never to key a new one.
 */
export function companyKey(accountName: string): string {
  return accountName
    .toLowerCase()
    .replace(/[äöüß]/g, (letter) => SPELLED_OUT[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Salesforce's language names → the codes our links and campaigns use ('de'). */
const LANGUAGE_CODES: ReadonlyMap<string, string> = new Map([
  ['albanian', 'sq'],
  ['bosnian', 'bs'],
  ['bulgarian', 'bg'],
  ['croatian', 'hr'],
  ['czech', 'cs'],
  ['danish', 'da'],
  ['dutch', 'nl'],
  ['english', 'en'],
  ['finnish', 'fi'],
  ['french', 'fr'],
  ['german', 'de'],
  ['greek', 'el'],
  ['hungarian', 'hu'],
  ['italian', 'it'],
  ['macedonian', 'mk'],
  ['norwegian', 'no'],
  ['polish', 'pl'],
  ['portuguese', 'pt'],
  ['romanian', 'ro'],
  ['russian', 'ru'],
  ['serbian', 'sr'],
  ['slovak', 'sk'],
  ['slovene', 'sl'],
  ['slovenian', 'sl'],
  ['spanish', 'es'],
  ['swedish', 'sv'],
  ['turkish', 'tr'],
  ['ukrainian', 'uk'],
])

/** 'German' → ['de']. Several languages come separated by ';' (a multi-select picklist) or ','. */
export function languageCodes(value: string | null | undefined): {
  codes: string[]
  unknown: string[]
} {
  const codes: string[] = []
  const unknown: string[] = []
  for (const name of (value ?? '').split(/[;,]/)) {
    const trimmed = name.trim()
    if (trimmed === '') continue
    const code = LANGUAGE_CODES.get(trimmed.toLowerCase())
    if (code === undefined) unknown.push(trimmed)
    else if (!codes.includes(code)) codes.push(code)
  }
  return { codes, unknown }
}

/**
 * N_N_Price__c in the record's currency. A price that cannot be stored exactly is left out with a
 * warning, never rounded: the campaign is still set up, and its cost fields stay null until it has one.
 */
function toPrice(
  value: number | null | undefined,
  currency: string | null | undefined,
): { value?: Price; warning?: string } {
  if (value === null || value === undefined)
    return { warning: 'no N_N_Price__c: the campaign has no price yet' }
  if (!currency) return { warning: 'N_N_Price__c without a CurrencyIsoCode: left out' }
  const price = priceSchema.safeParse({ value, currency: currency.toUpperCase() })
  if (!price.success) return { warning: `N_N_Price__c left out: ${describe(price.error)}` }
  return { value: price.data }
}

/** Field paths and messages only: never the values, which may be confidential deal terms. */
function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ')
}

/** The record's opportunity id, if it has a usable one, so a refusal can name the record. */
function idOf(record: unknown): string | null {
  const id = (record as { Id?: unknown } | null)?.Id
  return typeof id === 'string' && opportunityId.safeParse(id).success ? id.trim() : null
}
