import { RegistryMismatchError, UnknownSourceError } from './errors.ts'
import type { SourceConnector } from './types.ts'

export { UnknownSourceError }

export interface ConnectorRegistry {
  get(sourceId: string): SourceConnector
  ids(): string[]
}

export function createRegistry(connectors: readonly SourceConnector[]): ConnectorRegistry {
  const byId = new Map<string, SourceConnector>()
  for (const connector of connectors) {
    if (byId.has(connector.id)) {
      throw new RegistryMismatchError(`connector id '${connector.id}' is registered twice`)
    }
    byId.set(connector.id, connector)
  }
  return {
    get(sourceId) {
      const connector = byId.get(sourceId)
      if (!connector) throw new UnknownSourceError(sourceId, [...byId.keys()])
      return connector
    },
    ids: () => [...byId.keys()],
  }
}

/**
 * Boot check: every enabled platform source in external.source has a connector, and every
 * connector has a source row. Fails the boot rather than a run at 04:00.
 */
export function assertRegistryMatchesSources(
  registry: ConnectorRegistry,
  enabledPlatformSourceIds: readonly string[],
): void {
  const registered = new Set(registry.ids())
  const sources = new Set(enabledPlatformSourceIds)
  const missingConnectors = [...sources].filter((id) => !registered.has(id))
  const missingSources = [...registered].filter((id) => !sources.has(id))
  if (missingConnectors.length > 0 || missingSources.length > 0) {
    const parts: string[] = []
    if (missingConnectors.length > 0)
      parts.push(`no connector for: ${missingConnectors.join(', ')}`)
    if (missingSources.length > 0) {
      parts.push(`no enabled platform source row for: ${missingSources.join(', ')}`)
    }
    throw new RegistryMismatchError(
      `connector registry does not match external.source (${parts.join('; ')})`,
    )
  }
}
