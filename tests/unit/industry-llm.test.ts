import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createHttpClient } from '../../src/core/http/HttpClient.ts'
import {
  askIndustry,
  buildPrompt,
  INDUSTRY_MODEL,
  OPENROUTER_URL,
  pickIndustry,
  type AskDeps,
} from '../../src/modules/industries/llm.ts'

// The LLM step against a scripted OpenRouter: the exact prompt, the request, how an answer becomes
// an industry, and that a failure is "no answer" — never an exception, never the key in a log.

const KEY = 'sk-or-v1-test-0123456789abcdef0123456789'

const INDUSTRIES = [
  // Out of order on purpose: the prompt orders them by name itself.
  { name: 'Travel & Tourism', definition: 'Hotels, Travel Agencies, etc.' },
  { name: 'eCommerce', definition: 'eCommerce Platforms without physical stores' },
  { name: 'FMCG / CPG', definition: 'Fast Moving Consumer Goods' },
  { name: 'Other Industries', definition: 'Anything else.' },
  { name: 'Retail', definition: 'Own brick-and-mortar channels' },
]
const NAMES = INDUSTRIES.map((industry) => industry.name)

const INPUT = {
  campaignName: 'DE2611 Kaffee Winter',
  companyName: 'Some Agency GmbH',
  country: 'Germany',
}

interface Sent {
  url: string
  headers: Record<string, string>
  body: unknown
}

/** What HttpClient hands fetch: the URL as text, headers as an object, the JSON body as text. */
interface SentInit {
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

/** A client whose fetch answers with `answer` for every call, recording what was sent. */
function scripted(answer: (call: number, init: SentInit) => Response | Promise<Response>) {
  const sent: Sent[] = []
  const lines: string[] = []
  const http = createHttpClient({
    log: pino({ level: 'silent' }),
    maxRetries: 2,
    sleep: () => Promise.resolve(),
    random: () => 0,
    fetch: (async (url: string, init: SentInit) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as unknown })
      return answer(sent.length, init)
    }) as unknown as typeof fetch,
  })
  const log = pino({ level: 'debug' }, { write: (line: string) => lines.push(line) })
  const deps: AskDeps = { http, apiKey: KEY, log }
  return { deps, sent, lines }
}

const completion = (content: unknown, status = 200) =>
  new Response(JSON.stringify({ id: 'gen-1', choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('buildPrompt', () => {
  it('is the dashboard prompt word for word, the industries ordered by name', () => {
    expect(buildPrompt(INDUSTRIES, INPUT)).toBe(
      [
        'Du bist ein Kampagnen-Klassifizierer für BRAME, eine Gamification-Marketing-Plattform.',
        '',
        'Ordne die folgende Kampagne einer dieser Branchenkategorien zu. Die Definition jeder Kategorie steht nach dem Gedankenstrich:',
        'eCommerce — eCommerce Platforms without physical stores',
        'FMCG / CPG — Fast Moving Consumer Goods',
        'Other Industries — Anything else.',
        'Retail — Own brick-and-mortar channels',
        'Travel & Tourism — Hotels, Travel Agencies, etc.',
        '',
        'Kampagnenname: DE2611 Kaffee Winter',
        'Kunde: Some Agency GmbH',
        'Land: Germany',
        '',
        'Antworte NUR mit dem exakten Kategorienamen (genau wie oben geschrieben), nichts anderes.',
        'Falls keine Kategorie eindeutig passt, antworte: "Other Industries"',
      ].join('\n'),
    )
  })

  it('holds every definition and says Unbekannt for what is not known', () => {
    const prompt = buildPrompt(INDUSTRIES, { ...INPUT, companyName: null, country: null })
    for (const { name, definition } of INDUSTRIES)
      expect(prompt).toContain(`${name} — ${definition}`)
    expect(prompt).toContain(
      'Kampagnenname: DE2611 Kaffee Winter\nKunde: Unbekannt\nLand: Unbekannt',
    )
  })
})

describe('pickIndustry', () => {
  it('takes an exact answer, trimmed', () => {
    expect(pickIndustry('Retail', NAMES)).toBe('Retail')
    expect(pickIndustry('  FMCG / CPG\n', NAMES)).toBe('FMCG / CPG')
  })

  it.each([
    ['FMCG/CPG', 'FMCG / CPG'],
    ['fmcg / cpg', 'FMCG / CPG'],
    ['Travel and Tourism', 'Travel & Tourism'],
    ['"Retail"', 'Retail'],
    ['ECOMMERCE.', 'eCommerce'],
  ])('matches %s loosely to %s', (answer, industry) => {
    expect(pickIndustry(answer, NAMES)).toBe(industry)
  })

  it('makes an answer that names no industry Other Industries, never a new one', () => {
    expect(pickIndustry('Gaming', NAMES)).toBe('Other Industries')
    expect(pickIndustry('Retail, probably', NAMES)).toBe('Other Industries')
  })
})

describe('askIndustry', () => {
  it('posts the prompt to Gemini 2.5 Flash through OpenRouter with the key, and picks the answer', async () => {
    const { deps, sent } = scripted(() => completion('Retail'))

    expect(await askIndustry(deps, INDUSTRIES, INPUT)).toBe('Retail')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(OPENROUTER_URL)
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent[0]?.body).toEqual({
      model: INDUSTRY_MODEL,
      messages: [{ role: 'user', content: buildPrompt(INDUSTRIES, INPUT) }],
      temperature: 0.1,
      max_tokens: 50,
    })
    expect(INDUSTRY_MODEL).toBe('google/gemini-2.5-flash')
  })

  it('matches a loose answer and falls back to Other Industries', async () => {
    expect(await askIndustry(scripted(() => completion('FMCG/CPG')).deps, INDUSTRIES, INPUT)).toBe(
      'FMCG / CPG',
    )
    expect(await askIndustry(scripted(() => completion('Pharma')).deps, INDUSTRIES, INPUT)).toBe(
      'Other Industries',
    )
  })

  it('answers null rather than invent an industry when Other Industries is not in the list', async () => {
    const without = INDUSTRIES.filter((industry) => industry.name !== 'Other Industries')
    expect(await askIndustry(scripted(() => completion('Pharma')).deps, without, INPUT)).toBeNull()
  })

  it('answers null after a 500 that stays a 500, having retried twice', async () => {
    const { deps, sent } = scripted(() => new Response('upstream down', { status: 500 }))
    expect(await askIndustry(deps, INDUSTRIES, INPUT)).toBeNull()
    expect(sent).toHaveLength(3)
  })

  it.each([
    ['an empty answer', () => completion('   ')],
    ['a null answer', () => completion(null)],
    ['no choices', () => new Response(JSON.stringify({ choices: [] }), { status: 200 })],
    ['an error in a 200', () => new Response(JSON.stringify({ error: { code: 502 } }))],
    ['malformed JSON', () => new Response('{"choices": [', { status: 200 })],
    ['an HTML page', () => new Response('<html>busy</html>', { status: 200 })],
    ['a refused key', () => new Response('{"error":"No auth credentials"}', { status: 401 })],
  ])('answers null for %s', async (_name, answer) => {
    expect(await askIndustry(scripted(answer).deps, INDUSTRIES, INPUT)).toBeNull()
  })

  it('answers null when the network fails', async () => {
    const { deps } = scripted(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    })
    expect(await askIndustry(deps, INDUSTRIES, INPUT)).toBeNull()
  })

  it('passes an abort through as itself', async () => {
    const controller = new AbortController()
    const reason = new Error('SIGTERM')
    const { deps } = scripted(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
          controller.abort(reason)
        }),
    )
    await expect(
      askIndustry({ ...deps, signal: controller.signal }, INDUSTRIES, INPUT),
    ).rejects.toBe(reason)
  })

  it('never puts the key, the prompt or the answer in a log line', async () => {
    // A refusal that quotes the key back, then an answer that is no industry.
    for (const answer of [
      () => new Response(`{"error":"key ${KEY} is not valid"}`, { status: 401 }),
      () => completion('Pharma and Healthcare'),
      () => new Response(`<html>${KEY}</html>`, { status: 200 }),
    ]) {
      const { deps, lines } = scripted(answer)
      await askIndustry(deps, INDUSTRIES, INPUT)
      const logged = lines.join('\n')
      for (const secret of [KEY, 'Kaffee', 'Some Agency', 'Germany', 'Pharma']) {
        expect(logged).not.toContain(secret)
      }
    }
  })

  it('logs why a call failed, by status', async () => {
    const { deps, lines } = scripted(() => new Response('nope', { status: 401 }))
    await askIndustry(deps, INDUSTRIES, INPUT)
    expect(lines.join('\n')).toContain('"status":401')
  })
})
