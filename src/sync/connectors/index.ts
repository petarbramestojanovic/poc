import { createRegistry, type ConnectorRegistry } from '../registry.ts'
import { createNexdConnector } from './nexd/connector.ts'
import { createZeusConnector } from './zeus/connector.ts'

/** The connectors this service ships with. A new platform is one more entry here. */
export function createDefaultRegistry(): ConnectorRegistry {
  return createRegistry([createNexdConnector(), createZeusConnector()])
}
