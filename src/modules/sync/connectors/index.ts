import { createRegistry, type ConnectorRegistry } from '../registry.ts'
import { createNexdConnector } from './nexd/connector.ts'
import { createZeusConnector } from './zeus/connector.ts'

export interface DefaultRegistryOptions {
  nexd?: {
    /** The NEXD folder provisioned campaigns go into (NEXD_PROVISION_FOLDER_ID); null = root. */
    provisionFolderId?: string | null
  }
}

/** The connectors this service ships with. A new platform is one more entry here. */
export function createDefaultRegistry(options: DefaultRegistryOptions = {}): ConnectorRegistry {
  return createRegistry([
    createNexdConnector({ provisioning: { folderId: options.nexd?.provisionFolderId ?? null } }),
    createZeusConnector(),
  ])
}
