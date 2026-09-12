import type { SourceConnector } from './types.ts'

export class UnknownSourceError extends Error {
  override readonly name = 'UnknownSourceError'
  constructor(sourceId: string, known: readonly string[]) {
    super(`No connector registered for source '${sourceId}' (known: ${known.join(', ')})`)
  }
}

export interface ConnectorRegistry {
  get(sourceId: string): SourceConnector
  ids(): string[]
}

export function createRegistry(connectors: readonly SourceConnector[]): ConnectorRegistry {
  const byId = new Map(connectors.map((c) => [c.id, c]))
  return {
    get(sourceId) {
      const connector = byId.get(sourceId)
      if (!connector) throw new UnknownSourceError(sourceId, [...byId.keys()])
      return connector
    },
    ids: () => [...byId.keys()],
  }
}
