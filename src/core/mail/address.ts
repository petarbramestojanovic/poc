// One rule for an email address everywhere: config (MAIL_FROM, MAIL_REPLY_TO), the mailer, and
// whatever stores recipients. Deliberately narrower than RFC 5322: no quoted local parts, no
// comments, no IP literals, no internationalised domains, and nothing a header could be split on.

const MAX_ADDRESS_LENGTH = 254
const MAX_LOCAL_LENGTH = 64
const MAX_DISPLAY_NAME_LENGTH = 100

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
/** A display name may not carry what would end it or split the header: quotes, commas, <, >, controls. */
// eslint-disable-next-line no-control-regex
const DISPLAY_NAME = /^[^"<>,;:\\\u0000-\u001f\u007f]+$/
const NAMED_SENDER = /^(.*?)\s*<([^<>]*)>$/

export function isEmailAddress(value: string): boolean {
  if (value.length > MAX_ADDRESS_LENGTH) return false
  const at = value.lastIndexOf('@')
  if (at <= 0) return false
  const local = value.slice(0, at)
  const labels = value.slice(at + 1).split('.')
  const tld = labels.at(-1) ?? ''
  return (
    local.length <= MAX_LOCAL_LENGTH &&
    LOCAL_PART.test(local) &&
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL.test(label)) &&
    !/^\d+$/.test(tld)
  )
}

export interface Sender {
  readonly name?: string
  readonly address: string
}

/** Reads "address" or "Name <address>"; undefined when it is neither. */
export function parseSender(value: string): Sender | undefined {
  const trimmed = value.trim()
  const named = NAMED_SENDER.exec(trimmed)
  if (named === null) return isEmailAddress(trimmed) ? { address: trimmed } : undefined
  const name = (named[1] ?? '').trim()
  const address = (named[2] ?? '').trim()
  if (!isEmailAddress(address)) return undefined
  if (name === '') return { address }
  if (name.length > MAX_DISPLAY_NAME_LENGTH || !DISPLAY_NAME.test(name)) return undefined
  return { name, address }
}

export function formatSender(sender: Sender): string {
  return sender.name === undefined ? sender.address : `${sender.name} <${sender.address}>`
}

const ADDRESS_IN_TEXT = /[^\s<>()[\]"'`,;:]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

/**
 * Replaces anything shaped like an email address. A provider's error message can quote the
 * recipient or the account's own address, and those must not reach a log line or a stored excerpt.
 */
export function scrubAddresses(text: string): string {
  return text.replace(ADDRESS_IN_TEXT, '[address]')
}
