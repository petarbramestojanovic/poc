import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Queryable } from '../../core/db.ts'
import { todayIn } from '../../core/dates.ts'
import type { Logger } from '../../core/log.ts'
import { InvalidEventError, UnknownCampaignError } from './errors.ts'
import { isBot, parsePageEvent } from './event.ts'
import * as repo from './repo.ts'
import { TAG_SCRIPT } from './tag.ts'

// The public page tracker, registered in app.ts under PAGE_PREFIX with no token: a client's page
// calls it from any site, from any visitor's browser.
//
//   POST /pages/event   one visit or conversion (event.ts says what is read), counted with one
//                       upsert (repo.ts). 204 when counted, and for a bot, which is not counted.
//                       400 invalid_event, 404 unknown_campaign (none, or archived), 413 over 8 KB,
//                       415 a content type other than text/plain or application/json,
//                       503 busy.
//   OPTIONS /pages/event the CORS preflight of a page that posts application/json.
//   GET /pages/tag.js   the script (tag.ts), cached for an hour by the browser.
//
// Without a login, it never reads who is posting: limiting addresses is the edge's job (Cloudflare,
// planned), which sees every instance and the visitor's real address. What it guards itself is
// what only it can see. A campaign may get `combinationCap` new combinations of values a day (the
// upsert's own check), so the table stays bounded. And it works through its own share of the pool
// (`db` is limitDb'd in index.ts) and answers 503 rather than hold more than `maxInFlight` posts at
// once, so a flood never takes the connections a sync or a report needs, nor the process's memory.
//
// Fastify's request lines are off for these routes (they would carry every visitor's address); one
// line a minute counts the outcomes. No value a page sent and no address is ever logged.

export const PAGE_PREFIX = '/pages'

/** The tracker's share of the pool (RFC-002 §6.1: 10 per instance). */
export const PAGE_MAX_CONNECTIONS = 2

/** The longest body a post may have; a tag's is well under 1 KB. */
export const PAGE_BODY_LIMIT = 8 * 1024

export interface TrackingDeps {
  /** The tracker's own share of the pool (limitDb, PAGE_MAX_CONNECTIONS). */
  db: Queryable
  log: Logger
  combinationCap: number
  /**
   * Posts being counted at once (on a connection or waiting for one) beyond which the next is
   * answered 503 busy instead of queued. Default 200.
   */
  maxInFlight?: number
  now?: () => Date
  /** How often the outcome summary is logged. Default one minute. */
  summaryEveryMs?: number
}

type Outcome = 'counted' | 'overflow' | 'bot' | 'invalid' | 'unknown_campaign' | 'busy' | 'failed'

/** An answer the handler did not give itself, by its status. */
function outcomeOf(status: number): Outcome {
  if (status === 404) return 'unknown_campaign'
  if (status === 503) return 'busy'
  if (status >= 500) return 'failed'
  return 'invalid'
}

const QUIET = { logLevel: 'warn' } as const

export const pageRoutes: FastifyPluginAsync<{ deps: TrackingDeps }> = async (app, { deps }) => {
  const log = deps.log.child({ component: 'page-tracker' })
  const now = deps.now ?? (() => new Date())
  const maxInFlight = deps.maxInFlight ?? 200
  /** Counted synchronously, so a burst that arrives in one tick is held to it too. */
  let inFlight = 0

  let zone: Promise<string> | undefined
  /** Read once; a failed read is tried again by the next post. */
  const dayZone = (): Promise<string> => {
    zone ??= repo.loadDayZone(deps.db).catch((error: unknown) => {
      zone = undefined
      throw error
    })
    return zone
  }

  const outcomes = new WeakMap<FastifyRequest, Outcome>()
  const counts = new Map<Outcome, number>()
  const flush = () => {
    if (counts.size === 0) return
    log.info(Object.fromEntries(counts), 'page events')
    counts.clear()
  }
  const timer = setInterval(flush, deps.summaryEveryMs ?? 60_000)
  timer.unref()
  app.addHook('onClose', async () => {
    clearInterval(timer)
    flush()
  })

  // Every answer may be read by any page, errors included; none carries a credential.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('access-control-allow-origin', '*')
  })

  // sendBeacon posts a string as text/plain (no preflight); a page may also post JSON. Both are
  // read as JSON here, and anything unreadable is the same 400 as a bad field.
  app.removeContentTypeParser(['application/json', 'text/plain'])
  app.addContentTypeParser(
    ['application/json', 'text/plain'],
    { parseAs: 'string', bodyLimit: PAGE_BODY_LIMIT },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string) as unknown)
      } catch {
        done(new InvalidEventError(['']), undefined)
      }
    },
  )

  // Every post is counted once in the summary, also those refused before the handler (413, 415).
  const tally = async (request: FastifyRequest, reply: FastifyReply) => {
    const outcome = outcomes.get(request) ?? outcomeOf(reply.statusCode)
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
  }

  app.post(
    '/event',
    { ...QUIET, bodyLimit: PAGE_BODY_LIMIT, onResponse: tally },
    async (request, reply) => {
      if (isBot(request.headers['user-agent'])) {
        outcomes.set(request, 'bot')
        return reply.code(204).send()
      }
      const event = parsePageEvent(request.body)
      if (inFlight >= maxInFlight) {
        outcomes.set(request, 'busy')
        return reply.code(503).header('retry-after', '5').send({ error: 'busy' })
      }
      inFlight++
      try {
        const day = todayIn(await dayZone(), now())
        const counted = await repo.countEvent(deps.db, event, day, deps.combinationCap)
        if (counted === undefined) throw new UnknownCampaignError()
        outcomes.set(request, counted.overflow ? 'overflow' : 'counted')
        return await reply.code(204).send()
      } finally {
        inFlight--
      }
    },
  )

  app.options('/event', QUIET, async (_request, reply) =>
    reply
      .code(204)
      .header('access-control-allow-methods', 'POST')
      .header('access-control-allow-headers', 'Content-Type')
      .header('access-control-max-age', '86400')
      .send(),
  )

  app.get('/tag.js', QUIET, async (_request, reply) =>
    reply
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .header('x-content-type-options', 'nosniff')
      // A page that isolates itself (Cross-Origin-Embedder-Policy) may still load it.
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(TAG_SCRIPT),
  )
}
