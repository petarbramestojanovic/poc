import { z } from 'zod'
import { HttpError, type HttpClient } from '../../core/http/HttpClient.ts'
import type { Logger } from '../../core/log.ts'
import type { IndustryDefinition } from './repo.ts'

// The LLM step: Gemini 2.5 Flash through OpenRouter picks one of app.industry for a campaign whose
// brand the keyword table does not know. The prompt is the one of Brame's KPI dashboard, word for
// word, so both services classify alike.
//
// What leaves the service: the campaign name, the company (account) name and the country, and the
// industries with their definitions. Nothing else from a deal (approved with migration 0015).
// What is logged: why a call failed, never the prompt, the names or the model's answer.
//
// The model can never create an industry: whatever it says is matched against the list, and an
// answer that names none of them is Other Industries.

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const INDUSTRY_MODEL = 'google/gemini-2.5-flash'

/** What an answer naming no industry becomes. app.industry must have it (verifyIndustryMap). */
export const FALLBACK_INDUSTRY = 'Other Industries'

export interface ClassificationInput {
  campaignName: string
  companyName: string | null
  country: string | null
}

/**
 * The prompt, exactly. One line per industry, `name — definition`, ordered by name with a fixed
 * comparison, so the text never depends on the database's collation.
 */
export function buildPrompt(
  industries: readonly IndustryDefinition[],
  { campaignName, companyName, country }: ClassificationInput,
): string {
  const list = [...industries]
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map(({ name, definition }) => `${name} — ${definition}`)
    .join('\n')
  return `Du bist ein Kampagnen-Klassifizierer für BRAME, eine Gamification-Marketing-Plattform.

Ordne die folgende Kampagne einer dieser Branchenkategorien zu. Die Definition jeder Kategorie steht nach dem Gedankenstrich:
${list}

Kampagnenname: ${campaignName}
Kunde: ${companyName ?? 'Unbekannt'}
Land: ${country ?? 'Unbekannt'}

Antworte NUR mit dem exakten Kategorienamen (genau wie oben geschrieben), nichts anderes.
Falls keine Kategorie eindeutig passt, antworte: "Other Industries"`
}

/** "FMCG/CPG" = "FMCG / CPG", "Travel and Tourism" = "Travel & Tourism". */
const canon = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')

/** The industry an answer names: exactly, else loosely, else Other Industries. */
export function pickIndustry(answer: string, names: readonly string[]): string {
  const trimmed = answer.trim()
  if (names.includes(trimmed)) return trimmed
  const wanted = canon(trimmed)
  return names.find((name) => canon(name) === wanted) ?? FALLBACK_INDUSTRY
}

/** Only what is read: the first choice's text. Anything else in the answer is ignored. */
const completionSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({ content: z.string().nullish() }),
      }),
    )
    .min(1),
})

export interface AskDeps {
  http: HttpClient
  apiKey: string
  log: Logger
  signal?: AbortSignal
}

/**
 * Asks the model. Returns an industry of the list, or null when the call failed, timed out or
 * came back without an answer: the campaign then stays unclassified and a later push or the
 * backfill tries again. Never throws for those; an abort passes through as itself.
 */
export async function askIndustry(
  deps: AskDeps,
  industries: readonly IndustryDefinition[],
  input: ClassificationInput,
): Promise<string | null> {
  const names = industries.map((industry) => industry.name)
  let answer: string
  try {
    const res = await deps.http.request({
      method: 'POST',
      url: OPENROUTER_URL,
      headers: { authorization: `Bearer ${deps.apiKey}` },
      body: {
        model: INDUSTRY_MODEL,
        messages: [{ role: 'user', content: buildPrompt(industries, input) }],
        temperature: 0.1,
        max_tokens: 50,
      },
      credentialKey: 'openrouter',
      log: deps.log,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
    const parsed = completionSchema.safeParse(res.json())
    if (!parsed.success) {
      deps.log.warn({ reason: 'unexpected_shape' }, 'industry LLM answer unreadable')
      return null
    }
    answer = parsed.data.choices[0]?.message.content?.trim() ?? ''
  } catch (error) {
    // An abort (shutdown, Ctrl+C) is not a failed call: it stops the caller too.
    deps.signal?.throwIfAborted()
    deps.log.warn(failure(error), 'industry LLM call failed')
    return null
  }
  if (answer === '') {
    deps.log.warn({ reason: 'empty_answer' }, 'industry LLM answer unreadable')
    return null
  }
  const picked = pickIndustry(answer, names)
  // Other Industries missing from the list would be a name nobody may create: no answer then.
  return names.includes(picked) ? picked : null
}

/** Why a call failed, without its message: an error body may quote the request. */
function failure(error: unknown): { reason: string; status?: number } {
  if (error instanceof HttpError) return { reason: 'http_error', status: error.status }
  return { reason: error instanceof Error ? error.name : 'unknown' }
}
