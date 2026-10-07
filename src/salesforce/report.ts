import { z } from 'zod'
import {
  campaignSetupSchema,
  priceSchema,
  type CampaignSetup,
  type Price,
} from '../campaigns/input.ts'

// The daily Salesforce report "Media Solutions - Committed Opps - Daily", as another of our apps
// posts it to POST /inbound/campaigns (its JSON rendering of the emailed .xlsx), and how one of its
// rows becomes a CampaignSetup. Pure: no I/O. Salesforce's field names stop at this file.
//
// The report is a snapshot of committed opportunities, one row per campaign, every morning. A row
// missing from today's report means nothing — the report drops a campaign once it starts — so a
// push only ever creates or updates. Of a row, only the fields in rowSchema are read; the rest
// (amount, deliverables, targeting, owner, campaign manager, billing country …) is ignored and
// never stored.

/** externalRef.system of the campaigns and companies this report creates. */
export const REF_SYSTEM = 'salesforce'

/** The envelope. Loose: the sender may add fields. Rows are checked one by one, in toCampaignSetup. */
export const committedOppsReportSchema = z
  .looseObject({
    source: z.literal('salesforce_report'),
    report_name: z.string().max(300).optional(),
    report_as_of: z.string().max(64).optional(),
    record_count: z.int().min(0),
    /** Columns the sender found in the export and could not map: someone changed the report. */
    unmapped_columns: z.array(z.string().max(300)).max(200).default([]),
    campaigns: z.array(z.unknown()).max(5000),
  })
  .refine((report) => report.record_count === report.campaigns.length, {
    error: 'record_count does not match the number of campaigns',
    path: ['record_count'],
  })
export type CommittedOppsReport = z.infer<typeof committedOppsReportSchema>

/** Salesforce's own id of an opportunity: key prefix 006, 15 or 18 characters. */
const opportunityId = z
  .string()
  .trim()
  .regex(/^006[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/, 'not a Salesforce opportunity id')

const rowSchema = z.looseObject({
  opportunity_id: opportunityId,
  opportunity_name: z.string().trim().min(1).max(200),
  account_name: z.string().trim().min(1).max(200),
  currency: z.string().trim().nullish(),
  campaign_start_date: z.iso.date().nullish(),
  campaign_end_date: z.iso.date().nullish(),
  creative_languages: z.string().nullish(),
  /** The CPM the campaign is sold at. Always a CPM, whatever the row's billing type says. */
  nn_price: z.number().nullish(),
})

export type RowOutcome =
  | { ok: true; opportunityId: string; setup: CampaignSetup; warnings: string[] }
  | { ok: false; opportunityId: string | null; message: string }

/** One report row as a CampaignSetup, or why it cannot be one. Never throws. */
export function toCampaignSetup(row: unknown): RowOutcome {
  const parsed = rowSchema.safeParse(row)
  if (!parsed.success) {
    return { ok: false, opportunityId: idOf(row), message: describe(parsed.error) }
  }
  const opp = parsed.data
  const warnings: string[] = []

  const company = companyKey(opp.account_name)
  if (company === '') {
    return {
      ok: false,
      opportunityId: opp.opportunity_id,
      message: 'account_name has no letters or digits to make a company id from',
    }
  }

  const languages = languageCodes(opp.creative_languages)
  if (languages.unknown.length > 0) {
    warnings.push(`creative_languages not recognised, left out: ${languages.unknown.join(', ')}`)
  }

  const price = toPrice(opp.nn_price, opp.currency)
  if (price.warning !== undefined) warnings.push(price.warning)

  const setup = campaignSetupSchema.safeParse({
    externalRef: { system: REF_SYSTEM, id: opp.opportunity_id },
    company: { name: opp.account_name, externalRef: { system: REF_SYSTEM, id: company } },
    // The name as sold, market and month prefix included ('AT2610 Alpenmilch App Launch').
    name: opp.opportunity_name,
    // Left out rather than null: a push never clears what it does not state.
    ...(opp.campaign_start_date ? { startsOn: opp.campaign_start_date } : {}),
    ...(opp.campaign_end_date ? { endsOn: opp.campaign_end_date } : {}),
    ...(languages.codes.length > 0 ? { languages: languages.codes } : {}),
    ...(price.value === undefined ? {} : { price: price.value }),
  })
  if (!setup.success) {
    return { ok: false, opportunityId: opp.opportunity_id, message: describe(setup.error) }
  }
  return { ok: true, opportunityId: opp.opportunity_id, setup: setup.data, warnings }
}

const SPELLED_OUT: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }

/**
 * The company's id, made from the account name, because the report carries no account id:
 * lowercase, German umlauts spelled out, other accents dropped, every run of anything else one
 * '_'. 'Schloß Grünberg Kultur- u. Betriebsges.m.b.H.' → 'schloss_gruenberg_kultur_u_betriebsges_m_b_h'.
 * An account renamed in Salesforce therefore becomes a new company.
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

/** 'German' → ['de']. Several languages may come separated by ';' (Salesforce) or ','. */
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
 * nn_price with the row's currency. A price that cannot be stored exactly is left out with a
 * warning, never rounded: the campaign is still set up, and its cost fields stay null until it has one.
 */
function toPrice(
  value: number | null | undefined,
  currency: string | null | undefined,
): { value?: Price; warning?: string } {
  if (value === null || value === undefined)
    return { warning: 'no nn_price: the campaign has no price yet' }
  if (!currency) return { warning: 'nn_price without a currency: left out' }
  const price = priceSchema.safeParse({ value, currency: currency.toUpperCase() })
  if (!price.success) return { warning: `nn_price left out: ${describe(price.error)}` }
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

/** The row's opportunity id, if it has a usable one, so a refusal can name the row. */
function idOf(row: unknown): string | null {
  const id = (row as { opportunity_id?: unknown } | null)?.opportunity_id
  return typeof id === 'string' && opportunityId.safeParse(id).success ? id.trim() : null
}
