import type { HttpClient } from '../../http/HttpClient.ts'
import type { MailProvider, MailProviderConfig } from '../types.ts'
import { createMemoryProvider } from './memory/provider.ts'
import { createResendProvider } from './resend/provider.ts'

// The list of providers. A new one is a folder beside resend/, a case here, a name in
// MAIL_PROVIDER_NAMES (types.ts) and its key in config.ts and secrets.ts. Nothing that sends
// email changes.

export function createMailProvider(
  config: MailProviderConfig,
  deps: { http: HttpClient },
): MailProvider {
  switch (config.name) {
    case 'resend':
      return createResendProvider({ apiKey: config.apiKey, http: deps.http })
    case 'memory':
      return createMemoryProvider()
  }
}
