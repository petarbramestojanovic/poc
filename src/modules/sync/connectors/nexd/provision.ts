import { z } from 'zod'
import { HttpError } from '../../../../core/http/HttpClient.ts'
import { redact } from '../../../../core/http/redact.ts'
import type {
  ProvisionContext,
  ProvisionCampaignInput,
  ProvisionCreativeInput,
  ProvisionedCreative,
  ProvisionedStep,
  Provisioner,
  RawCapture,
} from '../../types.ts'
import { NexdProvisionError } from './errors.ts'
import { placeholderFilename, placeholderZip } from './placeholder.ts'

// Creating a campaign and its creatives on NEXD (apidoc.nexd.com, read 2026-11-08):
//
//   POST /v2/campaigns {name, folder_id}                        → Campaign {campaign_id}
//   POST /v2/import/async {campaign_id, folder_id, import:[…]}  → Creative[] {creative_id, status 71}
//   GET  /public/processing/import/{creative_id}/short          → 408 while importing, 200 when done
//   PUT  /creatives/{creative_id} {name}                        → the creative, renamed
//   POST /creatives/{creative_id}/publish                       → queues publishing (async)
//   GET  /campaigns/{campaign_id}/creatives/live                → {result:{creatives:[{creative_id, live_id}]}}
//
// The live id is what the sync asks NEXD for; it exists once publishing finished and survives a
// re-publish (checked on the account, 2026-11-08). Every step is resumable from the resources it
// already created: `campaign` (the NEXD campaign id) and `creative` (the import's creative id).
// NEXD wraps some answers in {result: …} and documents others bare; both are read.

export const NEXD_RESOURCE = { campaign: 'campaign', creative: 'creative' } as const

export interface NexdProvisionOptions {
  baseUrl: string
  /** The NEXD folder provisioned campaigns go into; null = the account root. */
  folderId: string | null
  /** How long to wait for an import, and for publishing to produce a live id. */
  importDeadlineMs?: number
  publishDeadlineMs?: number
  pollIntervalMs?: number
}

const DEFAULTS = { importDeadlineMs: 180_000, publishDeadlineMs: 180_000, pollIntervalMs: 3_000 }
const REQUEST_DEADLINE_MS = 60_000

const campaignSchema = z.looseObject({ campaign_id: z.string().min(1) })
const creativeSchema = z.looseObject({ creative_id: z.string().min(1) })
const liveCreativeSchema = z.looseObject({
  creative_id: z.string().min(1),
  live_id: z.string().nullable().optional(),
})
const liveListSchema = z.looseObject({ creatives: z.array(liveCreativeSchema) })

/** `{result: X}` or `X`: NEXD answers both ways. */
function unwrap<T extends z.ZodType>(schema: T) {
  return z.union([
    z.looseObject({ result: schema }).transform((v) => v.result as z.infer<T>),
    schema,
  ])
}

export function createNexdProvisioner(options: NexdProvisionOptions): Provisioner {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const importDeadlineMs = options.importDeadlineMs ?? DEFAULTS.importDeadlineMs
  const publishDeadlineMs = options.publishDeadlineMs ?? DEFAULTS.publishDeadlineMs
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs

  async function call<T>(
    ctx: ProvisionContext,
    client: 'http' | 'httpNoRetry',
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    schema: z.ZodType<T> | null,
    captureBody: unknown = body,
  ): Promise<{ status: number; data: T }> {
    const url = `${baseUrl}${path}`
    const response = await ctx[client].request({
      method,
      url,
      ...(body === undefined ? {} : { body }),
      headers: { authorization: `Bearer ${ctx.credential.secret}` },
      credentialKey: ctx.credential.id,
      log: ctx.log,
      deadlineMs: REQUEST_DEADLINE_MS,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    const json = response.text === '' ? null : response.json()
    await ctx.capture?.({
      request: redact({ method, url, ...(captureBody === undefined ? {} : { body: captureBody }) }),
      response: json,
      status: response.status,
      fetchedAt: (ctx.now?.() ?? new Date()).toISOString(),
    } satisfies RawCapture)
    if (schema === null) return { status: response.status, data: json as T }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new NexdProvisionError(
        `Unexpected NEXD response shape for ${method} ${path}: ${z.prettifyError(parsed.error)}`,
      )
    }
    return { status: response.status, data: parsed.data }
  }

  /** Polls with the no-retry client until `ready` says so or the deadline passes. */
  async function waitFor<T>(
    ctx: ProvisionContext,
    what: string,
    deadlineMs: number,
    attempt: () => Promise<T | undefined>,
  ): Promise<T> {
    const started = (ctx.now?.() ?? new Date()).getTime()
    for (;;) {
      ctx.signal?.throwIfAborted()
      const result = await attempt()
      if (result !== undefined) return result
      const elapsed = (ctx.now?.() ?? new Date()).getTime() - started
      if (elapsed + pollIntervalMs > deadlineMs) {
        throw new NexdProvisionError(`NEXD did not finish ${what} within ${deadlineMs} ms`)
      }
      await ctx.sleep(pollIntervalMs)
    }
  }

  async function importFinished(ctx: ProvisionContext, creativeId: string): Promise<boolean> {
    try {
      await call(
        ctx,
        'httpNoRetry',
        'GET',
        `/public/processing/import/${encodeURIComponent(creativeId)}/short`,
        undefined,
        null,
      )
      return true
    } catch (error) {
      // 408 is NEXD's "still importing", not a timeout of ours.
      if (error instanceof HttpError && error.status === 408) return false
      throw error
    }
  }

  async function liveIdOf(
    ctx: ProvisionContext,
    nexdCampaignId: string,
    creativeId: string,
  ): Promise<string | undefined> {
    const { data } = await call(
      ctx,
      'http',
      'GET',
      `/campaigns/${encodeURIComponent(nexdCampaignId)}/creatives/live`,
      undefined,
      unwrap(liveListSchema),
    )
    const live = data.creatives.find((c) => c.creative_id === creativeId)?.live_id
    // null, missing or '' all mean "not live yet".
    if (!live) return undefined
    return live
  }

  return {
    async provisionCampaign(ctx, input: ProvisionCampaignInput): Promise<ProvisionedStep> {
      if (input.existing.some((r) => r.kind === NEXD_RESOURCE.campaign)) {
        return { resources: [], warnings: [] }
      }
      // A campaign a person already pointed at its NEXD campaign (the link's campaign-level id)
      // is adopted, not created again: its new creatives go into that campaign.
      const adopted = input.linked?.find((e) => e.level === 'campaign')
      if (adopted) {
        return {
          resources: [{ kind: NEXD_RESOURCE.campaign, externalId: adopted.externalId }],
          warnings: [],
        }
      }
      const { data } = await call(
        ctx,
        'http',
        'POST',
        '/v2/campaigns',
        { name: input.campaign.name, folder_id: options.folderId },
        unwrap(campaignSchema),
      )
      return {
        resources: [{ kind: NEXD_RESOURCE.campaign, externalId: data.campaign_id }],
        warnings: [],
      }
    },

    async provisionCreative(ctx, input: ProvisionCreativeInput): Promise<ProvisionedCreative> {
      const nexdCampaignId = input.campaignResources.find(
        (r) => r.kind === NEXD_RESOURCE.campaign,
      )?.externalId
      if (!nexdCampaignId) {
        throw new NexdProvisionError(
          `campaign ${input.campaign.id} has no NEXD campaign yet; provision the campaign first`,
        )
      }
      const resources: ProvisionedCreative['resources'] = []
      const warnings: string[] = []
      const name = `${input.campaign.name} · ${input.creative.name}`

      let creativeId = input.existing.find((r) => r.kind === NEXD_RESOURCE.creative)?.externalId
      if (creativeId === undefined) {
        const zip = placeholderZip({
          campaignName: input.campaign.name,
          creativeName: input.creative.name,
        })
        const item = {
          type: 'zip',
          data: `data:application/zip;base64,${zip.toString('base64')}`,
          filename: placeholderFilename(input.creative.name),
        }
        const { data } = await call(
          ctx,
          'http',
          'POST',
          '/v2/import/async',
          { campaign_id: nexdCampaignId, folder_id: options.folderId, import: [item] },
          unwrap(z.array(creativeSchema).min(1)),
          // The zip is ours and the same every time: its bytes are not worth storing.
          {
            campaign_id: nexdCampaignId,
            folder_id: options.folderId,
            import: [{ ...item, data: `<zip ${zip.length} bytes>` }],
          },
        )
        const [created, ...extra] = data
        if (!created || extra.length > 0) {
          throw new NexdProvisionError(
            `NEXD answered the import of one creative with ${data.length} creatives`,
          )
        }
        creativeId = created.creative_id
        resources.push({ kind: NEXD_RESOURCE.creative, externalId: creativeId })
      }
      const importedId = creativeId

      await waitFor(ctx, `importing creative ${importedId}`, importDeadlineMs, async () =>
        (await importFinished(ctx, importedId)) ? true : undefined,
      )

      // Already published (a run that failed after publishing): nothing more to do.
      const already = await liveIdOf(ctx, nexdCampaignId, importedId)
      if (already !== undefined) {
        return { resources, warnings, entity: { externalId: already, label: input.creative.name } }
      }

      // The import names the creative after its file; a person reading NEXD should see ours.
      try {
        await call(
          ctx,
          'http',
          'PUT',
          `/creatives/${encodeURIComponent(importedId)}`,
          { name },
          null,
        )
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        warnings.push(
          `NEXD refused to rename creative ${importedId} (HTTP ${error.status}); it keeps its import name`,
        )
      }

      await call(
        ctx,
        'http',
        'POST',
        `/creatives/${encodeURIComponent(importedId)}/publish`,
        undefined,
        null,
      )
      const liveId = await waitFor(
        ctx,
        `publishing creative ${importedId}`,
        publishDeadlineMs,
        () => liveIdOf(ctx, nexdCampaignId, importedId),
      )
      return { resources, warnings, entity: { externalId: liveId, label: input.creative.name } }
    },
  }
}
