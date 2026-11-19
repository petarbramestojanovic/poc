import { describe, expect, it } from 'vitest'
import {
  HttpError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../../../src/core/http/HttpClient.ts'
import { createLogger } from '../../../src/core/log.ts'
import { at } from '../../helpers.ts'
import { createNexdConnector } from '../../../src/modules/sync/connectors/nexd/connector.ts'
import { NexdProvisionError } from '../../../src/modules/sync/connectors/nexd/errors.ts'
import {
  createNexdProvisioner,
  NEXD_RESOURCE,
} from '../../../src/modules/sync/connectors/nexd/provision.ts'
import {
  provisions,
  type ProvisionContext,
  type ProvisionedResourceRecord,
  type RawCapture,
} from '../../../src/modules/sync/types.ts'

// Creating a campaign and a creative on NEXD against a scripted API (apidoc.nexd.com, 2026-11-08):
// which endpoint gets what, how the 408 of a running import is waited out without the retrying
// client, how a run that failed halfway resumes, and what is captured.

const CAMPAIGN = {
  id: 'c0c0c0c0-0000-4000-8000-000000000003',
  name: 'DE2611 Tchibo Winter',
  externalRef: { system: 'salesforce', id: '006Rp00000ABCDE' },
}
const CREATIVE = {
  id: 'a0a0a0a0-0000-4000-8000-000000000001',
  tag: 'a0a0a0a0-0000-4000-8000-000000000001',
  type: 'Swipe Card',
  name: 'Swipe Card',
}
const resource = (
  kind: string,
  externalId: string,
  creativeId: string | null = null,
): ProvisionedResourceRecord => ({ source: 'nexd', kind, externalId, creativeId })

interface Seen {
  client: 'http' | 'httpNoRetry'
  method: string
  path: string
  body: unknown
}

/**
 * A NEXD that imports in `importPolls` + 1 status polls and, once publishing was asked for, goes
 * live after `livePolls` + 1 looks at the live list; `alreadyLive` = published in an earlier run.
 */
function fakeNexd(
  over: { importPolls?: number; livePolls?: number; wrapped?: boolean; alreadyLive?: boolean } = {},
) {
  const seen: Seen[] = []
  let importPolls = over.importPolls ?? 2
  let livePolls = over.livePolls ?? (over.alreadyLive ? 0 : 1)
  let published = over.alreadyLive ?? false
  const wrap = (value: unknown) => ((over.wrapped ?? true) ? { result: value } : value)

  const respond = (req: HttpRequest, client: Seen['client']): HttpResponse => {
    const path = new URL(req.url).pathname
    seen.push({ client, method: req.method, path, body: req.body })
    const json = (value: unknown, status = 200): HttpResponse => ({
      status,
      headers: new Headers(),
      text: JSON.stringify(value),
      json: () => value,
    })
    if (req.method === 'POST' && path === '/v2/campaigns')
      return json(wrap({ campaign_id: 'nxCamp' }))
    if (req.method === 'POST' && path === '/v2/import/async') {
      return json(wrap([{ creative_id: 'nxCr1', status: 71 }]))
    }
    if (path === '/public/processing/import/nxCr1/short') {
      if (importPolls-- > 0) throw new HttpError(408, req.url, '')
      return json({ creative_id: 'nxCr1', imported: true })
    }
    if (req.method === 'PUT' && path === '/creatives/nxCr1')
      return json(wrap({ creative_id: 'nxCr1' }))
    if (req.method === 'POST' && path === '/creatives/nxCr1/publish') {
      published = true
      return { status: 200, headers: new Headers(), text: '', json: () => null }
    }
    if (path === '/campaigns/nxCamp/creatives/live') {
      const live = published && livePolls-- <= 0 ? 'LIVE1' : null
      return json(wrap({ creatives: [{ creative_id: 'nxCr1', live_id: live }] }))
    }
    throw new Error(`unexpected ${req.method} ${path}`)
  }
  const client = (name: Seen['client']): HttpClient => ({
    request: (req) => {
      try {
        return Promise.resolve(respond(req, name))
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })
  return { seen, http: client('http'), httpNoRetry: client('httpNoRetry') }
}

function context(
  fake: ReturnType<typeof fakeNexd>,
): ProvisionContext & { captures: RawCapture[]; slept: number[] } {
  const captures: RawCapture[] = []
  const slept: number[] = []
  // A fake clock: every faked sleep moves it, so the deadlines are real without waiting.
  let clock = Date.UTC(2026, 10, 8, 12, 0, 0)
  return {
    credential: { id: 'cred', name: 'nexd-main', secret: 'sk-secret', accountScope: {} },
    http: fake.http,
    httpNoRetry: fake.httpNoRetry,
    log: createLogger('silent'),
    capture: async (raw) => {
      captures.push(raw)
    },
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
    },
    now: () => new Date(clock),
    captures,
    slept,
  }
}

const provisioner = (over: { folderId?: string | null } = {}) =>
  createNexdProvisioner({
    baseUrl: 'https://nexd.test',
    folderId: over.folderId ?? 'folder-1',
    pollIntervalMs: 100,
    importDeadlineMs: 1_000,
    publishDeadlineMs: 1_000,
  })

describe('NEXD provisioning', () => {
  it('creates the campaign in the configured folder and hands its id back as a resource', async () => {
    const fake = fakeNexd()
    const step = await provisioner().provisionCampaign(context(fake), {
      campaign: CAMPAIGN,
      existing: [],
    })

    expect(step).toEqual({
      resources: [{ kind: NEXD_RESOURCE.campaign, externalId: 'nxCamp' }],
      warnings: [],
    })
    expect(fake.seen).toEqual([
      {
        client: 'http',
        method: 'POST',
        path: '/v2/campaigns',
        body: { name: 'DE2611 Tchibo Winter', folder_id: 'folder-1' },
      },
    ])
  })

  it('creates no second campaign when the resource is already there', async () => {
    const fake = fakeNexd()
    const step = await provisioner().provisionCampaign(context(fake), {
      campaign: CAMPAIGN,
      existing: [resource(NEXD_RESOURCE.campaign, 'nxCamp')],
    })
    expect(step.resources).toEqual([])
    expect(fake.seen).toEqual([])
  })

  it('imports the placeholder, waits out the 408s without retries, renames, publishes, and returns the live id', async () => {
    const fake = fakeNexd({ importPolls: 2, livePolls: 1 })
    const ctx = context(fake)

    const step = await provisioner().provisionCreative(ctx, {
      campaign: CAMPAIGN,
      campaignResources: [resource(NEXD_RESOURCE.campaign, 'nxCamp')],
      creative: CREATIVE,
      existing: [],
    })

    expect(step.resources).toEqual([{ kind: NEXD_RESOURCE.creative, externalId: 'nxCr1' }])
    expect(step.entity).toEqual({ externalId: 'LIVE1', label: 'Swipe Card' })
    expect(step.warnings).toEqual([])

    const calls = fake.seen.map((s) => `${s.client} ${s.method} ${s.path}`)
    expect(calls).toEqual([
      'http POST /v2/import/async',
      'httpNoRetry GET /public/processing/import/nxCr1/short', // 408
      'httpNoRetry GET /public/processing/import/nxCr1/short', // 408
      'httpNoRetry GET /public/processing/import/nxCr1/short', // done
      'http GET /campaigns/nxCamp/creatives/live', // not published yet: nothing live
      'http PUT /creatives/nxCr1',
      'http POST /creatives/nxCr1/publish',
      'http GET /campaigns/nxCamp/creatives/live', // live_id null: publishing
      'http GET /campaigns/nxCamp/creatives/live', // LIVE1
    ])
    expect(ctx.slept).toEqual([100, 100, 100])

    // The import body: one zip item for the campaign, in the folder, named after the creative.
    const imported = at(fake.seen).body as {
      campaign_id: string
      folder_id: string
      import: { type: string; data: string; filename: string }[]
    }
    expect(imported.campaign_id).toBe('nxCamp')
    expect(imported.folder_id).toBe('folder-1')
    expect(imported.import).toHaveLength(1)
    const item = at(imported.import)
    expect(item.type).toBe('zip')
    expect(item.data.startsWith('data:application/zip;base64,UEsDB')).toBe(true) // PK\x03\x04
    expect(item.filename).toBe('swipe-card-300x600.zip')
    expect(at(fake.seen, 5).body).toEqual({ name: 'DE2611 Tchibo Winter · Swipe Card' })

    // Every answer is captured (a 408 is a refusal, not an answer), the zip bytes are not, and the
    // secret is nowhere.
    expect(ctx.captures).toHaveLength(7)
    const importCapture = JSON.stringify(ctx.captures[0])
    expect(importCapture).toContain('<zip ')
    expect(importCapture).not.toContain('UEsDB')
    expect(JSON.stringify(ctx.captures)).not.toContain('sk-secret')
  })

  it('resumes: an imported creative is not imported again, a published one is not published again', async () => {
    const fake = fakeNexd({ importPolls: 0, alreadyLive: true })
    const step = await provisioner().provisionCreative(context(fake), {
      campaign: CAMPAIGN,
      campaignResources: [resource(NEXD_RESOURCE.campaign, 'nxCamp')],
      creative: CREATIVE,
      existing: [resource(NEXD_RESOURCE.creative, 'nxCr1', CREATIVE.id)],
    })

    expect(step.resources).toEqual([])
    expect(step.entity).toEqual({ externalId: 'LIVE1', label: 'Swipe Card' })
    expect(fake.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /public/processing/import/nxCr1/short',
      'GET /campaigns/nxCamp/creatives/live', // already live: done
    ])
  })

  it('refuses a creative before its campaign exists on NEXD', async () => {
    const fake = fakeNexd()
    await expect(
      provisioner().provisionCreative(context(fake), {
        campaign: CAMPAIGN,
        campaignResources: [],
        creative: CREATIVE,
        existing: [],
      }),
    ).rejects.toBeInstanceOf(NexdProvisionError)
    expect(fake.seen).toEqual([])
  })

  it('gives up when the import never finishes, as a provision error (502, retryable)', async () => {
    const fake = fakeNexd({ importPolls: 100 })
    const error = await provisioner()
      .provisionCreative(context(fake), {
        campaign: CAMPAIGN,
        campaignResources: [resource(NEXD_RESOURCE.campaign, 'nxCamp')],
        creative: CREATIVE,
        existing: [],
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NexdProvisionError)
    expect(error).toMatchObject({ code: 'provision_failed', status: 502, retryable: true })
    expect((error as Error).message).toContain('importing creative nxCr1')
  })

  it('reads NEXD answers bare or wrapped in result', async () => {
    const fake = fakeNexd({ wrapped: false, importPolls: 0, livePolls: 0 })
    const step = await provisioner().provisionCreative(context(fake), {
      campaign: CAMPAIGN,
      campaignResources: [resource(NEXD_RESOURCE.campaign, 'nxCamp')],
      creative: CREATIVE,
      existing: [],
    })
    expect(step.entity?.externalId).toBe('LIVE1')
  })

  it('keeps going when the rename is refused: the name is a courtesy, the live id is the point', async () => {
    const fake = fakeNexd({ importPolls: 0, livePolls: 0 })
    const refusing: HttpClient = {
      request: (req) =>
        req.method === 'PUT'
          ? Promise.reject(new HttpError(403, req.url, ''))
          : fake.http.request(req),
    }
    const step = await provisioner().provisionCreative(
      { ...context(fake), http: refusing },
      {
        campaign: CAMPAIGN,
        campaignResources: [resource(NEXD_RESOURCE.campaign, 'nxCamp')],
        creative: CREATIVE,
        existing: [],
      },
    )
    expect(step.entity?.externalId).toBe('LIVE1')
    expect(step.warnings).toEqual([
      'NEXD refused to rename creative nxCr1 (HTTP 403); it keeps its import name',
    ])
  })

  it('adopts the NEXD campaign a person already named on the link instead of creating one', async () => {
    const fake = fakeNexd()
    const step = await provisioner().provisionCampaign(context(fake), {
      campaign: CAMPAIGN,
      existing: [],
      linked: [
        { level: 'creative', externalId: 'oldLive' },
        { level: 'campaign', externalId: 'nxExisting' },
      ],
    })
    expect(step.resources).toEqual([{ kind: NEXD_RESOURCE.campaign, externalId: 'nxExisting' }])
    expect(fake.seen).toEqual([]) // nothing asked of NEXD
  })

  it('is a capability the NEXD connector declares, with the folder it was given', async () => {
    const connector = createNexdConnector({
      baseUrl: 'https://nexd.test',
      provisioning: { folderId: 'folder-9' },
    })
    expect(provisions(connector)).toBe(true)
    const fake = fakeNexd()
    await connector.provisionCampaign(context(fake), { campaign: CAMPAIGN, existing: [] })
    expect(at(fake.seen).body).toEqual({ name: CAMPAIGN.name, folder_id: 'folder-9' })
  })
})
