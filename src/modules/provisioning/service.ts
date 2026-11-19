import type { Db } from '../../core/db.ts'
import { AppError } from '../../core/errors.ts'
import type { HttpClient } from '../../core/http/HttpClient.ts'
import { redact } from '../../core/http/redact.ts'
import type { Logger } from '../../core/log.ts'
import { InvalidSecretPointerError, MissingSecretError, resolveSecret } from '../../core/secrets.ts'
import { sourceSetupSchema, type SourceSetup } from '../campaigns/input.ts'
import { isPresetPlatform, PLATFORM_PRESETS, type ProvisionedEntity } from '../campaigns/presets.ts'
import type { CampaignDetail, CreativeRecord } from '../campaigns/repo.ts'
import {
  addPlatformIds,
  describeExternalIds,
  ensureCreativesForTypes,
  findCampaignDetail,
  type CampaignDeps,
} from '../campaigns/service.ts'
import { CredentialUnavailableError, ProvisionError } from '../sync/errors.ts'
import type { ConnectorRegistry } from '../sync/registry.ts'
import * as credentials from '../sync/repo.ts'
import {
  provisions,
  type Credential,
  type EntityLevel,
  type ExternalIdInput,
  type ProvisionContext,
  type RawCapture,
} from '../sync/types.ts'
import { NothingToProvisionError, ProvisioningInProgressError } from './errors.ts'
import * as repo from './repo.ts'

// Provisioning: a campaign that exists for us comes into being on the platforms. One creative per
// creative type the CRM named (app.creative); every connector that can create things does so for
// the campaign and each creative; what it hands back is stored as it happens
// (external.provisioned_resource), and the id the sync will ask for becomes a link entity. Then
// every connector that derives the ids another platform must be told (Zeus) gets its link written
// with those strings. The job knows no platform by name: capabilities and presets do.
//
// Resumable by construction: each step reads what already exists and does only what is missing,
// and each step's resources commit before the next step starts, so a run that failed halfway is
// simply run again. One run per campaign at a time (repo.openRun).

export interface ProvisioningDeps {
  db: Db
  registry: ConnectorRegistry
  /** Retrying client for the platform calls. */
  http: HttpClient
  /** A client with no retries, for polling endpoints whose "not yet" is a retryable status. */
  httpNoRetry: HttpClient
  log: Logger
  /** The campaign setup the job writes through. */
  campaigns: CampaignDeps
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

export interface ProvisioningResult {
  runId: string
  campaignId: string
  /** The campaign's creatives after the run, one per creative type. */
  creatives: number
  /** Per source: new resources stored and platform ids added to the campaign's links. */
  sources: { source: string; resourcesAdded: number; entitiesAdded: number }[]
  warnings: string[]
}

/** How many request/response pairs a run keeps, and how long each may be. */
const MAX_STEPS = 60
const MAX_STEP_CHARS = 4_000

export interface ProvisionOptions {
  /** Only these creatives (by id) are created on the platforms; the campaign step still runs. */
  creativeIds?: readonly string[]
}

export async function provisionCampaign(
  deps: ProvisioningDeps,
  campaignId: string,
  trigger: repo.ProvisioningTrigger,
  options: ProvisionOptions = {},
): Promise<ProvisioningResult> {
  const provisioners = deps.registry
    .ids()
    .sort()
    .map((id) => deps.registry.get(id))
    .filter(provisions)
  if (provisioners.length === 0) {
    throw new NothingToProvisionError('no connector can create campaigns or creatives')
  }

  const detail = await findCampaignDetail(deps.campaigns, campaignId)
  const all = await ensureCreativesForTypes(deps.campaigns, campaignId)
  const creatives =
    options.creativeIds === undefined
      ? all
      : all.filter((creative) => options.creativeIds?.includes(creative.id))
  if (creatives.length === 0) {
    throw new NothingToProvisionError(
      options.creativeIds === undefined
        ? `campaign ${campaignId} names no creative type, so there is no creative to create`
        : `campaign ${campaignId} has none of the creatives named`,
    )
  }

  const runId = await repo.openRun(deps.db, campaignId, trigger)
  if (runId === undefined) {
    throw new ProvisioningInProgressError(`campaign ${campaignId} is being provisioned already`)
  }
  const log = deps.log.child({ provisioningRunId: runId, campaignId, trigger })
  const warnings: string[] = []
  const steps: unknown[] = []
  // What the run said to the platforms, redacted, capped in count and in size: a response too big
  // to keep whole is kept as its first MAX_STEP_CHARS characters, still valid JSON around it.
  const capture = (raw: RawCapture): Promise<void> => {
    if (steps.length < MAX_STEPS) {
      const safe = redact(raw)
      // JSON.stringify(undefined) is undefined at run time, whatever its type says.
      const text = (JSON.stringify(safe.response) as string | undefined) ?? 'null'
      steps.push(
        text.length > MAX_STEP_CHARS
          ? { ...safe, response: { truncated: text.slice(0, MAX_STEP_CHARS) } }
          : safe,
      )
    }
    return Promise.resolve()
  }
  const campaign: ExternalIdInput['campaign'] = {
    id: detail.id,
    name: detail.name,
    externalRef: detail.externalRef,
  }
  const sources: ProvisioningResult['sources'] = []

  try {
    for (const connector of provisioners) {
      const ctx: ProvisionContext = {
        credential: await loadCredential(deps, connector.id),
        http: deps.http,
        httpNoRetry: deps.httpNoRetry,
        log: log.child({ source: connector.id }),
        capture,
        sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      }
      const own = async () =>
        (await repo.listResources(deps.db, campaignId)).filter((r) => r.source === connector.id)
      let resourcesAdded = 0

      deps.signal?.throwIfAborted()
      const campaignStep = await connector.provisionCampaign(ctx, {
        campaign,
        existing: (await own()).filter((r) => r.creativeId === null),
        linked: detail.links
          .filter((link) => link.source === connector.id)
          .flatMap((link) =>
            link.entities.map((e) => ({ level: e.level as EntityLevel, externalId: e.externalId })),
          ),
      })
      resourcesAdded += await repo.insertResources(
        deps.db,
        { campaignId, creativeId: null, sourceId: connector.id },
        campaignStep.resources,
      )
      warnings.push(...campaignStep.warnings)

      let entitiesAdded = 0
      for (const creative of creatives) {
        deps.signal?.throwIfAborted()
        const resources = await own()
        const step = await connector.provisionCreative(ctx, {
          campaign,
          campaignResources: resources.filter((r) => r.creativeId === null),
          creative: {
            id: creative.id,
            tag: creative.tag,
            type: creative.type,
            name: creative.name,
          },
          existing: resources.filter((r) => r.creativeId === creative.id),
        })
        resourcesAdded += await repo.insertResources(
          deps.db,
          { campaignId, creativeId: creative.id, sourceId: connector.id },
          step.resources,
        )
        warnings.push(...step.warnings)
        // The id the sync asks for goes on the link right away: a failure on the next creative
        // must not lose this one.
        if (step.entity) {
          const entity: ProvisionedEntity = {
            level: 'creative',
            externalId: step.entity.externalId,
            creative: { tag: creative.tag, name: creative.name },
          }
          const added = await addPlatformIds(
            deps.campaigns,
            campaignId,
            setupFor(connector.id, [entity]),
          )
          entitiesAdded += added.entitiesAdded
        }
      }
      sources.push({ source: connector.id, resourcesAdded, entitiesAdded })
    }

    // The platforms that are told their ids rather than asked: write what can be derived now.
    sources.push(...(await writeDerivedIds(deps, campaignId, creatives)))

    await repo.finishRun(deps.db, runId, { error: null, warnings, steps })
    log.info({ sources, warnings: warnings.length }, 'campaign provisioned')
    return { runId, campaignId, creatives: creatives.length, sources, warnings }
  } catch (error) {
    const failure =
      error instanceof AppError
        ? error
        : new ProvisionError(`provisioning failed: ${describe(error)}`, { cause: error })
    await repo.finishRun(deps.db, runId, { error: redact(failure.message), warnings, steps })
    log.error({ err: failure, sources }, 'provisioning failed')
    throw failure
  }
}

/**
 * For every connector that derives the ids its platform must be told (Zeus): the link with those
 * ids, created or added to. Only what is not linked yet is written, so a second run adds nothing.
 */
async function writeDerivedIds(
  deps: ProvisioningDeps,
  campaignId: string,
  creatives: readonly CreativeRecord[],
): Promise<ProvisioningResult['sources']> {
  const detail = await findCampaignDetail(deps.campaigns, campaignId)
  const derived = (await describeExternalIds(deps.campaigns, detail)).filter((d) => !d.linked)
  const bySource = new Map<string, ProvisionedEntity[]>()
  for (const d of derived) {
    const creative = d.creativeId === null ? null : creatives.find((c) => c.id === d.creativeId)
    if (d.creativeId !== null && !creative) continue
    const list = bySource.get(d.source) ?? []
    list.push({
      level: d.level,
      externalId: d.externalId,
      creative: creative ? { tag: creative.tag, name: creative.name } : null,
    })
    bySource.set(d.source, list)
  }
  const written: ProvisioningResult['sources'] = []
  for (const [source, entities] of bySource) {
    const result = await addPlatformIds(deps.campaigns, campaignId, setupFor(source, entities))
    written.push({ source, resourcesAdded: 0, entitiesAdded: result.entitiesAdded })
  }
  return written
}

/** The link a source's provisioned ids are written as: its preset's convention, or the bare ids. */
function setupFor(source: string, entities: readonly ProvisionedEntity[]): SourceSetup {
  if (isPresetPlatform(source)) return PLATFORM_PRESETS[source].fromProvisioned(entities)
  return sourceSetupSchema.parse({
    source,
    entities: entities.map((entity) => ({
      level: entity.level,
      externalId: entity.externalId,
      ...(entity.creative ? { label: entity.creative.name, campaignTag: entity.creative.tag } : {}),
      ...(entity.creative ? {} : { campaignTag: '' }),
    })),
  })
}

/** The one enabled credential of a source, its secret resolved; anything else is an error. */
async function loadCredential(deps: ProvisioningDeps, sourceId: string): Promise<Credential> {
  const enabled = (await credentials.findCredentials(deps.db, { sourceId })).filter(
    (c) => c.enabled,
  )
  const [only, ...others] = enabled
  if (!only || others.length > 0) {
    throw new CredentialUnavailableError(
      only
        ? `${sourceId} has several enabled credentials; provisioning needs exactly one`
        : `${sourceId} has no enabled credential`,
    )
  }
  try {
    return {
      id: only.id,
      name: only.name,
      secret: resolveSecret(only.secretEnvVar, deps.env),
      accountScope: only.accountScope,
    }
  } catch (error) {
    if (error instanceof MissingSecretError || error instanceof InvalidSecretPointerError) {
      throw new CredentialUnavailableError(`credential ${only.name}: ${error.message}`, {
        cause: error,
      })
    }
    throw error
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export type { CampaignDetail }
