import { InvalidLinkConfigError } from '../sync/errors.ts'
import type { ConnectorRegistry } from '../sync/registry.ts'
import type { SourceConnector } from '../sync/types.ts'
import { InvalidSetupError, UnsupportedSourceError } from './errors.ts'
import type { SourceSetup } from './input.ts'

// Pure checks of a setup against what each source's connector says it accepts. Nothing here
// touches the database, and nothing here knows a platform by name: the connector declares its
// entity levels, its roles and its config schema (RFC-003 §3), and a setup either fits or it is
// refused before a single row is written — not at 04:00, when the first sync would trip over it.

/**
 * Returns each source with its config as the connector parsed it (defaults applied), or throws.
 */
export function checkSources(
  registry: ConnectorRegistry,
  sources: readonly SourceSetup[],
): SourceSetup[] {
  const slices = new Set<string>()
  return sources.map((source) => {
    const slice = `${source.source}/${source.language}`
    if (slices.has(slice)) {
      throw new InvalidSetupError(
        `source ${source.source} is set up twice for language '${source.language}'`,
      )
    }
    slices.add(slice)

    const connector = connectorFor(registry, source.source)
    checkEntities(connector, source)
    return { ...source, config: checkConfig(connector, source) }
  })
}

function connectorFor(registry: ConnectorRegistry, sourceId: string): SourceConnector {
  if (!registry.ids().includes(sourceId)) {
    throw new UnsupportedSourceError(
      `no connector for source '${sourceId}' (known: ${registry.ids().join(', ')})`,
    )
  }
  return registry.get(sourceId)
}

function checkEntities(connector: SourceConnector, source: SourceSetup): void {
  const { levels, multiple, roles } = connector.identity
  if (!multiple && source.entities.length > 1) {
    throw new InvalidSetupError(`${connector.id} accepts one entity per link`)
  }

  const seen = new Set<string>()
  for (const entity of source.entities) {
    const key = `${entity.level}/${entity.externalId}`
    if (seen.has(key)) {
      throw new InvalidSetupError(
        `${connector.id} ${entity.level} ${entity.externalId} is listed twice`,
      )
    }
    seen.add(key)

    if (!levels.includes(entity.level)) {
      throw new InvalidSetupError(
        `${connector.id} does not accept '${entity.level}' entities (accepts: ${levels.join(', ')})`,
      )
    }

    const allowedRoles = roles?.[entity.level]
    if (allowedRoles === undefined) {
      if (entity.role !== undefined) {
        throw new InvalidSetupError(`${connector.id} ${entity.level} entities take no role`)
      }
    } else if (entity.role === undefined || !allowedRoles.includes(entity.role)) {
      throw new InvalidSetupError(
        `${connector.id} ${entity.level} ${entity.externalId} needs a role: ${allowedRoles.join(' or ')}`,
      )
    }
  }
}

function checkConfig(connector: SourceConnector, source: SourceSetup): Record<string, unknown> {
  const parsed = connector.describe().configSchema.safeParse(source.config)
  if (parsed.success) return parsed.data as Record<string, unknown>

  // Field paths and messages only — never the values (the same rule the engine follows).
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }))
  throw new InvalidLinkConfigError(
    `config is invalid for ${connector.id}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    issues,
  )
}
