import { describe, expect, it } from 'vitest'
import { InvalidEventError } from '../../src/modules/tracking/errors.ts'
import {
  charLength,
  cleanReferrer,
  cleanValue,
  FIELD_MAX_CHARS,
  isBot,
  parsePageEvent,
  TRACKED_FIELDS,
} from '../../src/modules/tracking/event.ts'

// What a client's page posts to /pages/event, and what of it is stored. A post comes from any
// browser on any site, so every value is checked and cleaned here, before SQL sees it.

const CAMPAIGN = '7f1c9a52-3b9e-4c8e-9a51-2f6b1d0c4e88'

const EMPTY_VALUES = Object.fromEntries(TRACKED_FIELDS.map((field) => [field, '']))

function invalidPaths(body: unknown): string[] {
  try {
    parsePageEvent(body)
  } catch (error) {
    if (error instanceof InvalidEventError) return error.paths
    throw error
  }
  throw new Error('expected the body to be refused')
}

describe('parsePageEvent', () => {
  it('needs only the campaign id: a visit with nothing else, not split by language', () => {
    expect(parsePageEvent({ campaign_id: CAMPAIGN })).toEqual({
      campaignId: CAMPAIGN,
      event: 'visit',
      language: '',
      values: EMPTY_VALUES,
    })
  })

  it('reads every tracked field, and a conversion', () => {
    const body = {
      campaign_id: CAMPAIGN,
      event: 'conversion',
      language: 'de',
      referrer: 'https://www.example.com/',
      utm_source: 'Brame',
      utm_medium: 'display',
      utm_campaign: 'kw47',
      utm_content: 'tiles',
      utm_term: 'kaffee',
      brame_1: 'one',
      brame_2: 'two',
      brame_3: 'three',
    }
    expect(parsePageEvent(body)).toEqual({
      campaignId: CAMPAIGN,
      event: 'conversion',
      language: 'de',
      values: {
        referrer: 'https://www.example.com/',
        utm_source: 'Brame',
        utm_medium: 'display',
        utm_campaign: 'kw47',
        utm_content: 'tiles',
        utm_term: 'kaffee',
        brame_1: 'one',
        brame_2: 'two',
        brame_3: 'three',
      },
    })
  })

  it('takes null as empty: URLSearchParams.get answers null for a missing parameter', () => {
    const parsed = parsePageEvent({ campaign_id: CAMPAIGN, utm_source: null, language: null })
    expect(parsed.values.utm_source).toBe('')
    expect(parsed.language).toBe('')
  })

  it('ignores fields it does not know, so an older or newer script still counts', () => {
    expect(parsePageEvent({ campaign_id: CAMPAIGN, utm_id: 'x', gclid: 'y' }).values).toEqual(
      EMPTY_VALUES,
    )
  })

  it('reads the campaign id in any case, and keeps it lower case', () => {
    expect(parsePageEvent({ campaign_id: CAMPAIGN.toUpperCase() }).campaignId).toBe(CAMPAIGN)
  })

  it('lower-cases the language and accepts a two- or three-letter code', () => {
    expect(parsePageEvent({ campaign_id: CAMPAIGN, language: ' DE ' }).language).toBe('de')
    expect(parsePageEvent({ campaign_id: CAMPAIGN, language: 'gsw' }).language).toBe('gsw')
    expect(parsePageEvent({ campaign_id: CAMPAIGN, language: '' }).language).toBe('')
  })

  it.each([
    ['not an object', ''],
    [null, ''],
    [[], ''],
    [{}, 'campaign_id'],
    [{ campaign_id: 'DEV0001' }, 'campaign_id'],
    [{ campaign_id: `${CAMPAIGN}_generic` }, 'campaign_id'],
    [{ campaign_id: CAMPAIGN, event: 'click' }, 'event'],
    [{ campaign_id: CAMPAIGN, utm_source: 42 }, 'utm_source'],
    [{ campaign_id: CAMPAIGN, utm_source: ['a'] }, 'utm_source'],
    [{ campaign_id: CAMPAIGN, referrer: { href: 'x' } }, 'referrer'],
    [{ campaign_id: CAMPAIGN, language: 'deutsch' }, 'language'],
    [{ campaign_id: CAMPAIGN, language: 'de-CH' }, 'language'],
    [{ campaign_id: CAMPAIGN, language: 'd' }, 'language'],
  ])('refuses %j, naming %s', (body, path) => {
    expect(invalidPaths(body)).toContain(path)
  })

  it('names every bad field and never quotes a value', () => {
    let refused: unknown
    try {
      parsePageEvent({ campaign_id: 'secret-looking-value', utm_source: 7, event: 'oops-value' })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(InvalidEventError)
    const error = refused as InvalidEventError
    expect(error.paths.sort()).toEqual(['campaign_id', 'event', 'utm_source'])
    expect(error.status).toBe(400)
    expect(error.code).toBe('invalid_event')
    expect(error.message).not.toContain('secret-looking-value')
    expect(error.message).not.toContain('oops-value')
  })

  it('cleans every value it keeps', () => {
    const parsed = parsePageEvent({
      campaign_id: CAMPAIGN,
      utm_source: '  News\u0000letter\n ',
      referrer: 'https://news.example.com/article?user=jane@example.com#top',
    })
    expect(parsed.values.utm_source).toBe('Newsletter')
    expect(parsed.values.referrer).toBe('https://news.example.com/article')
  })
})

describe('cleanValue', () => {
  it('keeps quotes, SQL and HTML as plain text: they are data', () => {
    expect(cleanValue("O'Reilly'); DROP TABLE x; --")).toBe("O'Reilly'); DROP TABLE x; --")
    expect(cleanValue('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
  })

  it('keeps the case: utm values are case-sensitive in every analytics tool', () => {
    expect(cleanValue('Brame')).toBe('Brame')
  })

  it('removes control characters, also inside the value, and trims', () => {
    expect(cleanValue('\t a\u0007b\u001fc\u007f\u0085 \r\n')).toBe('abc')
  })

  it('keeps letters outside ASCII', () => {
    expect(cleanValue('Zürich Käse 日本 🎉')).toBe('Zürich Käse 日本 🎉')
  })

  it('cuts a long value to 255 characters ending in …, so the visit still counts', () => {
    const cut = cleanValue('x'.repeat(10_000))
    expect(charLength(cut)).toBe(FIELD_MAX_CHARS)
    expect(cut.endsWith('…')).toBe(true)
    expect(cleanValue('y'.repeat(FIELD_MAX_CHARS))).toBe('y'.repeat(FIELD_MAX_CHARS))
  })

  it('counts characters, not UTF-16 units, and never cuts one in half', () => {
    const emoji = '🎉'.repeat(300)
    const cut = cleanValue(emoji)
    expect(charLength(cut)).toBe(FIELD_MAX_CHARS)
    expect(cut).toBe(`${'🎉'.repeat(FIELD_MAX_CHARS - 1)}…`)
    expect(cleanValue('🎉'.repeat(FIELD_MAX_CHARS))).toBe('🎉'.repeat(FIELD_MAX_CHARS))
  })

  it('makes null, undefined and blanks empty', () => {
    expect(cleanValue(null)).toBe('')
    expect(cleanValue(undefined)).toBe('')
    expect(cleanValue('   ')).toBe('')
  })
})

describe('cleanReferrer', () => {
  it.each([
    ['https://www.google.com/', 'https://www.google.com/'],
    ['https://www.google.com', 'https://www.google.com/'],
    ['https://shop.example.com/a/b?email=jane%40example.com&id=7', 'https://shop.example.com/a/b'],
    ['https://example.com/page#section', 'https://example.com/page'],
    ['https://user:pass@example.com/private', 'https://example.com/private'],
    ['HTTPS://Example.COM/Path', 'https://example.com/Path'],
    ['android-app://com.google.android.gm/', 'android-app://com.google.android.gm/'],
    ['google', 'google'],
    ['not a url ?q=jane', 'not a url'],
    ['', ''],
  ])('keeps %s as %s', (input, expected) => {
    expect(cleanReferrer(input)).toBe(expected)
  })

  it('is cut like any other value', () => {
    const long = `https://example.com/${'p'.repeat(400)}`
    expect(charLength(cleanReferrer(long))).toBe(FIELD_MAX_CHARS)
  })
})

describe('isBot', () => {
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'curl/8.5.0',
    'python-requests/2.31.0',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; YandexSpider/3.0)',
    '',
    undefined,
  ])('counts %j as a bot', (agent) => {
    expect(isBot(agent)).toBe(true)
  })

  it.each([
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 309.0.0.40.113',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    // A phone brand, not a bot: a plain /bot/ would drop every Cubot owner.
    'Mozilla/5.0 (Linux; Android 10; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  ])('counts %j as a person', (agent) => {
    expect(isBot(agent)).toBe(false)
  })
})
