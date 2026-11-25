import { readFileSync } from 'node:fs'
import { runInContext, createContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { TAG_SCRIPT } from '../../src/modules/tracking/tag.ts'

// The script a client's page loads (GET /pages/tag.js), run as a browser would run it: the exact
// bytes the service serves, in a fresh context with a fake window. It must count one visit per page
// load, remember where the visitor came from for the length of the tab, report a conversion with
// those values, and never break the page it runs on.

const SRC = 'https://analytics.example.com/pages/tag.js'
const ENDPOINT = 'https://analytics.example.com/pages/event'
const CAMPAIGN = '7f1c9a52-3b9e-4c8e-9a51-2f6b1d0c4e88'
const OTHER = '0b7d2c11-1111-4a2b-8c3d-9e8f7a6b5c4d'

interface Sent {
  via: 'beacon' | 'fetch'
  url: string
  body: Record<string, unknown>
  init?: Record<string, unknown>
}

interface PageOptions {
  url?: string
  referrer?: string
  campaign?: string | null
  language?: string
  /** Simulates a tag manager that leaves document.currentScript unset. */
  noCurrentScript?: boolean
  beacon?: 'ok' | 'refused' | 'throws' | 'missing'
  storage?: Map<string, string> | 'throws'
  prerendering?: boolean
}

class FakeScript {
  readonly src: string
  private readonly attributes: Record<string, string>

  constructor(src: string, attributes: Record<string, string>) {
    this.src = src
    this.attributes = attributes
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }
}

/** A browser tab: one page, its sessionStorage and everything the tag sends from it. */
function page(options: PageOptions = {}) {
  const sent: Sent[] = []
  const errors: unknown[] = []
  const listeners = new Map<string, (() => void)[]>()
  const storage = options.storage ?? new Map<string, string>()
  const attributes: Record<string, string> = {}
  if (options.campaign !== null) attributes['data-campaign'] = options.campaign ?? CAMPAIGN
  if (options.language !== undefined) attributes['data-language'] = options.language
  const script = new FakeScript(SRC, attributes)
  const location = new URL(options.url ?? 'https://shop.example.com/landing')

  const sessionStorage =
    storage === 'throws'
      ? {
          getItem() {
            throw new Error('SecurityError')
          },
          setItem() {
            throw new Error('SecurityError')
          },
        }
      : {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        }

  const beacon = options.beacon ?? 'ok'
  const navigator =
    beacon === 'missing'
      ? {}
      : {
          sendBeacon(url: string, data: unknown) {
            if (beacon === 'throws') throw new TypeError('Illegal invocation')
            if (beacon === 'refused') return false
            expect(typeof data).toBe('string') // a string is sent as text/plain: no preflight
            sent.push({
              via: 'beacon',
              url,
              body: JSON.parse(data as string) as Record<string, unknown>,
            })
            return true
          },
        }

  const document: { currentScript: FakeScript | null } & Record<string, unknown> = {
    currentScript: options.noCurrentScript ? null : script,
    referrer: options.referrer ?? '',
    prerendering: options.prerendering ?? false,
    querySelector: (selector: string) => {
      expect(selector).toContain('data-campaign')
      return script
    },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
  }

  const context = createContext({
    document,
    navigator,
    location: { href: location.href, search: location.search },
    sessionStorage,
    URL,
    URLSearchParams,
    fetch(url: string, init: Record<string, unknown>) {
      sent.push({
        via: 'fetch',
        url,
        body: JSON.parse(init.body as string) as Record<string, unknown>,
        init,
      })
      return Promise.resolve({})
    },
  }) as Record<string, unknown>
  context.window = context

  const run = () => {
    try {
      runInContext(TAG_SCRIPT, context)
    } catch (error) {
      errors.push(error)
    }
  }
  run()

  return {
    sent,
    errors,
    storage,
    window: context as { brame?: { conversion?: (campaign?: string) => void } },
    /** Runs the tag again in the same page, as a second <script> tag would. */
    loadAgain: run,
    /** A second tag on the same page, for another campaign. */
    loadTag(campaign: string) {
      document.currentScript = new FakeScript(SRC, { 'data-campaign': campaign })
      run()
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener()
    },
    /** A later page load in the same tab: a new window, the same sessionStorage. */
    next(url: string, referrer: string, more: PageOptions = {}) {
      return page({ ...options, ...more, url, referrer, storage })
    },
  }
}

const values = (over: Record<string, string> = {}) => ({
  referrer: '',
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  utm_content: '',
  utm_term: '',
  brame_1: '',
  brame_2: '',
  brame_3: '',
  ...over,
})

describe('the page tag (GET /pages/tag.js)', () => {
  it('is the file the service serves, small and without modules', () => {
    const file = readFileSync(
      new URL('../../src/modules/tracking/assets/tag.js', import.meta.url),
      'utf8',
    )
    expect(TAG_SCRIPT).toBe(file)
    expect(Buffer.byteLength(TAG_SCRIPT)).toBeLessThan(4096)
    expect(TAG_SCRIPT).not.toMatch(/^\s*(import|export)\s/m)
  })

  it('posts one visit with the page URL parameters and the referrer', () => {
    const tab = page({
      url: 'https://shop.example.com/landing?utm_source=Brame&utm_medium=display&utm_campaign=kw47&utm_content=tiles&utm_term=kaffee&brame_1=a&brame_2=b&brame_3=c&gclid=x',
      referrer: 'https://news.example.com/article',
      language: 'de',
    })
    expect(tab.errors).toEqual([])
    expect(tab.sent).toEqual([
      {
        via: 'beacon',
        url: ENDPOINT,
        body: {
          campaign_id: CAMPAIGN,
          event: 'visit',
          language: 'de',
          ...values({
            referrer: 'https://news.example.com/article',
            utm_source: 'Brame',
            utm_medium: 'display',
            utm_campaign: 'kw47',
            utm_content: 'tiles',
            utm_term: 'kaffee',
            brame_1: 'a',
            brame_2: 'b',
            brame_3: 'c',
          }),
        },
      },
    ])
  })

  it('posts a visit without parameters too: every page load counts, as before', () => {
    const tab = page({ url: 'https://shop.example.com/' })
    expect(tab.sent).toHaveLength(1)
    expect(tab.sent[0]?.body).toEqual({
      campaign_id: CAMPAIGN,
      event: 'visit',
      language: '',
      ...values(),
    })
  })

  it('reports a conversion on a later page with the values the visitor arrived with', () => {
    const landing = page({
      url: 'https://shop.example.com/?utm_source=Brame&utm_medium=display',
      referrer: 'https://news.example.com/',
      language: 'fr',
    })
    const form = landing.next('https://shop.example.com/form', 'https://shop.example.com/')
    expect(form.sent[0]?.body).toMatchObject({
      event: 'visit',
      referrer: 'https://shop.example.com/',
      utm_source: '',
    })

    form.window.brame?.conversion?.()
    expect(form.sent[1]).toEqual({
      via: 'beacon',
      url: ENDPOINT,
      body: {
        campaign_id: CAMPAIGN,
        event: 'conversion',
        language: 'fr',
        ...values({
          referrer: 'https://news.example.com/',
          utm_source: 'Brame',
          utm_medium: 'display',
        }),
      },
    })
  })

  it('keeps the landing referrer for a conversion when the visitor came without parameters', () => {
    const landing = page({ url: 'https://shop.example.com/', referrer: 'https://www.google.com/' })
    const form = landing.next('https://shop.example.com/form', 'https://shop.example.com/')
    form.window.brame?.conversion?.()
    expect(form.sent[1]?.body).toEqual({
      campaign_id: CAMPAIGN,
      event: 'conversion',
      language: '',
      ...values({ referrer: 'https://www.google.com/' }),
    })
  })

  it('lets a new click with parameters in the same tab replace what was kept', () => {
    const first = page({ url: 'https://shop.example.com/?utm_source=Newsletter' })
    const second = first.next(
      'https://shop.example.com/?utm_source=Brame',
      'https://news.example.com/',
    )
    second.window.brame?.conversion?.()
    expect(second.sent[1]?.body).toMatchObject({
      event: 'conversion',
      utm_source: 'Brame',
      referrer: 'https://news.example.com/',
    })
  })

  it('stores nothing but the values it sends, and only in sessionStorage', () => {
    const tab = page({ url: 'https://shop.example.com/?utm_source=Brame' })
    expect([...(tab.storage as Map<string, string>).keys()]).toEqual([`brame:${CAMPAIGN}`])
    expect(JSON.parse((tab.storage as Map<string, string>).get(`brame:${CAMPAIGN}`) ?? '')).toEqual(
      values({ utm_source: 'Brame' }),
    )
  })

  it('still counts the visit when sessionStorage is blocked, and converts with this page', () => {
    const tab = page({ url: 'https://shop.example.com/?utm_source=Brame', storage: 'throws' })
    expect(tab.errors).toEqual([])
    expect(tab.sent).toHaveLength(1)
    tab.window.brame?.conversion?.()
    expect(tab.sent[1]?.body).toMatchObject({ event: 'conversion', utm_source: 'Brame' })
  })

  it('falls back to fetch with keepalive when sendBeacon is missing or refuses', () => {
    for (const beacon of ['missing', 'refused', 'throws'] as const) {
      const tab = page({ beacon })
      expect(tab.errors).toEqual([])
      expect(tab.sent).toHaveLength(1)
      expect(tab.sent[0]).toMatchObject({
        via: 'fetch',
        url: ENDPOINT,
        init: {
          method: 'POST',
          keepalive: true,
          mode: 'no-cors',
          credentials: 'omit',
          headers: { 'Content-Type': 'text/plain' },
        },
      })
    }
  })

  it('does nothing without data-campaign, and never throws', () => {
    const tab = page({ campaign: null })
    expect(tab.errors).toEqual([])
    expect(tab.sent).toEqual([])
  })

  it('finds its own tag when the tag manager leaves currentScript unset', () => {
    const tab = page({ noCurrentScript: true })
    expect(tab.sent).toHaveLength(1)
    expect(tab.sent[0]?.url).toBe(ENDPOINT)
  })

  it('waits while the browser only pre-renders the page', () => {
    const tab = page({ prerendering: true })
    expect(tab.sent).toEqual([])
    tab.fire('prerenderingchange')
    expect(tab.sent).toHaveLength(1)
  })

  it('counts a page once when the same tag is on it twice', () => {
    const tab = page()
    tab.loadAgain()
    expect(tab.sent).toHaveLength(1)
  })

  it('converts for every campaign on the page, or only the one named', () => {
    const tab = page()
    tab.loadTag(OTHER)
    expect(tab.sent.map((s) => s.body.campaign_id)).toEqual([CAMPAIGN, OTHER])

    const conversions = () =>
      tab.sent.filter((s) => s.body.event === 'conversion').map((s) => s.body.campaign_id)
    tab.window.brame?.conversion?.(OTHER)
    expect(conversions()).toEqual([OTHER])
    tab.window.brame?.conversion?.()
    expect(conversions()).toEqual([OTHER, CAMPAIGN, OTHER])
    tab.window.brame?.conversion?.('not-on-this-page')
    expect(conversions()).toHaveLength(3)
  })

  it('never lets an error reach the page, even when sending throws', () => {
    const tab = page({ beacon: 'throws' })
    const broken = tab.window as { fetch?: unknown }
    broken.fetch = () => {
      throw new Error('blocked by an extension')
    }
    expect(() => tab.window.brame?.conversion?.()).not.toThrow()
  })
})
