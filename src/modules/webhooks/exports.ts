import type { Db } from '../../core/db.ts'
import type { Logger } from '../../core/log.ts'
import * as repo from './repo.ts'
import { signExport, verifyExport } from './sign.ts'

// GET /exports/<delivery-id>.csv?exp=…&sig=… (routes.ts) — the CSV of a `csv` webhook's delivery,
// for the client's importer to fetch (Funnel's File Import webhook takes a link, never the file).
// The route is public: the link is the only key, like a pre-signed storage URL. It is signed with
// the webhook's own secret over the delivery id and an expiry a week after the attempt that sent
// it, so a link cannot be guessed, altered or reused for another delivery, and stops working.
//
// What it serves is the text stored on the delivery row, byte for byte. Every refusal — malformed,
// unknown, expired, a bad signature, a JSON webhook, a disabled one — is the same 404, so the route
// tells a stranger nothing. The query string carries the signature, so Fastify's own request log is
// off for this route; the route logs each answer itself, by delivery id, never with the link.

export const EXPORT_PREFIX = '/exports'

/** How long a link POSTed to the client works; Funnel fetches it within minutes. */
export const EXPORT_LINK_TTL_MS = 7 * 24 * 3_600_000

const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.csv$/
const EXPIRES = /^\d{1,12}$/
const SIGNATURE = /^[0-9a-f]{64}$/

/** The link to a delivery's CSV, valid for EXPORT_LINK_TTL_MS from `now`. */
export function exportLink(baseUrl: string, deliveryId: string, secret: string, now: Date): string {
  const expires = Math.floor((now.getTime() + EXPORT_LINK_TTL_MS) / 1000)
  const sig = signExport(deliveryId, expires, secret)
  return `${baseUrl}${EXPORT_PREFIX}/${deliveryId}.csv?exp=${String(expires)}&sig=${sig}`
}

export interface ExportDeps {
  db: Db
  log: Logger
  now?: () => Date
}

/** Why a request got the 404, for the log; the requester never learns which. */
export type Refusal = 'malformed' | 'unknown' | 'expired' | 'signature' | 'not_csv' | 'disabled'

export type ExportLookup =
  | { found: true; deliveryId: string; webhookId: string; csv: string }
  | { found: false; reason: Refusal; deliveryId?: string }

/** The CSV a link points at, or why there is none. `file` is `<delivery-id>.csv`. */
export async function findExport(
  db: Db,
  file: string,
  query: Record<string, unknown>,
  now: Date,
): Promise<ExportLookup> {
  const id = FILE.exec(file)?.[1]
  const { exp, sig } = query
  if (id === undefined || typeof exp !== 'string' || typeof sig !== 'string') {
    return { found: false, reason: 'malformed' }
  }
  const refuse = (reason: Refusal): ExportLookup => ({ found: false, reason, deliveryId: id })
  if (!EXPIRES.test(exp) || !SIGNATURE.test(sig)) return refuse('malformed')

  const expires = Number(exp)
  if (expires * 1000 <= now.getTime()) return refuse('expired')

  const delivery = await repo.loadExport(db, id)
  if (!delivery) return refuse('unknown')
  if (!verifyExport(id, expires, delivery.secret, sig)) return refuse('signature')
  if (delivery.format !== 'csv' || typeof delivery.payload !== 'string') return refuse('not_csv')
  if (!delivery.enabled) return refuse('disabled')

  return { found: true, deliveryId: id, webhookId: delivery.webhookId, csv: delivery.payload }
}
