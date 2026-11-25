import { z } from 'zod'
import { InvalidEventError } from './errors.ts'

// What a client's page posts to POST /pages/event, and what of it is kept. The post comes from any
// browser on any site, so every value is checked and cleaned here before SQL sees it:
//
//   * campaign_id is our own campaign id (app.campaign.id); the old Brame ids are not read.
//   * event is 'visit' (a page load, the default) or 'conversion' (the page reports one).
//   * The nine tracked fields are free text, as the page found them: a string, or null (what
//     URLSearchParams.get answers for a missing parameter) for empty. Trimmed, control characters
//     removed, cut to FIELD_MAX_CHARS characters ending in '…' so a long value still counts and
//     the cut shows. Case is kept: utm values are case-sensitive in every analytics tool.
//   * The referrer loses its query string and fragment (a query can carry an email address or a
//     token; and every query would be a combination of its own) and any user:password.
//   * language: a two- or three-letter code, lower-cased; '' = the page did not say.
//
// Fields the schema does not know are ignored, so an older or newer tag still counts.

/** The values a visit is counted by: the analytics.utm_daily columns, and the report dimensions. */
export const TRACKED_FIELDS = [
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'brame_1',
  'brame_2',
  'brame_3',
] as const

export type TrackedField = (typeof TRACKED_FIELDS)[number]

export const PAGE_EVENTS = ['visit', 'conversion'] as const
export type PageEventKind = (typeof PAGE_EVENTS)[number]

/** The CHECK on every text column of analytics.utm_daily. */
export const FIELD_MAX_CHARS = 255

export interface PageEvent {
  campaignId: string
  event: PageEventKind
  /** '' = not split by language. */
  language: string
  values: Record<TrackedField, string>
}

const text = z.string().nullish()

const pageEventSchema = z.object({
  campaign_id: z.guid(),
  event: z.enum(PAGE_EVENTS).default('visit'),
  language: text.refine((value) => value == null || /^([a-z]{2,3})?$/.test(clean(value)), {
    error: 'must be a two- or three-letter language code',
  }),
  ...(Object.fromEntries(TRACKED_FIELDS.map((field) => [field, text])) as Record<
    TrackedField,
    typeof text
  >),
})

/** The checked and cleaned event, or InvalidEventError naming the fields that are wrong. */
export function parsePageEvent(body: unknown): PageEvent {
  const parsed = pageEventSchema.safeParse(body)
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.map(String).join('.'))
    throw new InvalidEventError([...new Set(paths)])
  }
  const data = parsed.data
  const values = Object.fromEntries(
    TRACKED_FIELDS.map((field) => [
      field,
      field === 'referrer' ? cleanReferrer(data.referrer) : cleanValue(data[field]),
    ]),
  ) as Record<TrackedField, string>
  return {
    campaignId: data.campaign_id.toLowerCase(),
    event: data.event,
    language: clean(data.language ?? ''),
    values,
  }
}

// Every C0 and C1 control character and DEL (Unicode category Cc), anywhere in the value.
const CONTROL = /\p{Cc}/gu

/** Lower-cased, trimmed and without control characters: the language code before its check. */
function clean(value: string): string {
  return value.replace(CONTROL, '').trim().toLowerCase()
}

/** Trimmed, without control characters, and at most FIELD_MAX_CHARS characters. */
export function cleanValue(value: string | null | undefined): string {
  if (value == null) return ''
  return cut(value.replace(CONTROL, '').trim())
}

/**
 * The page the visitor came from, without query string, fragment or user:password. A value that is
 * not a URL is kept up to its first '?' or '#'.
 */
export function cleanReferrer(value: string | null | undefined): string {
  const bare = cleanValue(value === undefined || value === null ? '' : value.split(/[?#]/, 1)[0])
  if (bare === '') return ''
  if (!/^[a-z][a-z0-9+.-]*:/i.test(bare)) return bare
  try {
    const url = new URL(bare)
    url.username = ''
    url.password = ''
    return cut(url.href)
  } catch {
    return bare
  }
}

/** Characters as Postgres's char_length counts them: code points, never UTF-16 units. */
export function charLength(value: string): number {
  let length = 0
  for (const _char of value) length++
  return length
}

/** At most FIELD_MAX_CHARS characters, the last one '…' when cut; an emoji is never cut in half. */
function cut(value: string): string {
  if (charLength(value) <= FIELD_MAX_CHARS) return value
  let kept = ''
  let count = 0
  for (const char of value) {
    if (++count === FIELD_MAX_CHARS) break
    kept += char
  }
  return `${kept}…`
}

// Crawlers, link previews, headless browsers, audit tools and HTTP libraries: none of them is a
// person looking at the page. Phone brands that contain "bot" (Cubot) are taken out first.
const BOT =
  /bot\b|bot[/_-]|crawl|spider|slurp|archiver|headless|lighthouse|pagespeed|externalhit|preview|facebookcatalog|bingpreview|scrapy|phantomjs|selenium|puppeteer|playwright|^curl\/|^wget\/|^python-|^java\/|^go-http-client|^okhttp|^axios\/|^node-fetch|^undici|^got\b|httpclient|^libwww|^ruby|^php\//i
const NOT_BOT = /cubot/gi

/** True for an agent that is not a person's browser; an empty or missing agent included. */
export function isBot(userAgent: string | undefined): boolean {
  if (userAgent === undefined || userAgent.trim() === '') return true
  return BOT.test(userAgent.replace(NOT_BOT, ''))
}
