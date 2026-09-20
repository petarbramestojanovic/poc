import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { BlockedTargetError } from './errors.ts'

// RFC-002 §15.5, egress guard: a webhook URL must point at a public HTTPS address, so a client (or
// a tampered row) cannot aim a signed POST at the service's own network — the cloud metadata
// endpoint (169.254.169.254), a database on a private subnet, or localhost.
//
// The check runs before EVERY attempt, not only when the row is written: DNS changes, and a row
// can be edited between attempts. Two things it deliberately does not do:
//   * it cannot close the gap between our resolution and the one the HTTP stack makes a moment
//     later (DNS rebinding); pinning the resolved address needs a custom dispatcher, which is a
//     phase-2 change. `redirect: 'error'` in HttpClient closes the much easier redirect bypass.
//   * it does not vouch for what lives at a public address.

/** Every address of the host must be public; one private answer refuses the whole target. */
export type Lookup = (hostname: string) => Promise<{ address: string }[]>

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

export async function assertPublicTarget(
  url: string,
  lookup: Lookup = defaultLookup,
): Promise<void> {
  let target: URL
  try {
    target = new URL(url)
  } catch (cause) {
    throw new BlockedTargetError(`webhook url is not a URL`, { cause })
  }
  if (target.protocol !== 'https:') {
    throw new BlockedTargetError(`webhook url must be https, got ${target.protocol}`)
  }

  const host = target.hostname.replace(/^\[|]$/g, '') // an IPv6 literal arrives in brackets
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new BlockedTargetError(`webhook url resolves to ${host}`)
    return
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(host)
  } catch (cause) {
    throw new BlockedTargetError(`webhook host ${host} does not resolve`, { cause })
  }
  if (addresses.length === 0) {
    throw new BlockedTargetError(`webhook host ${host} does not resolve`)
  }
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new BlockedTargetError(`webhook host ${host} resolves to ${address}`)
    }
  }
}

/** Pure: is this IP literal routable on the public internet? Unknown shapes are refused. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPublicV4(address)
  if (version === 6) return isPublicV6(address.toLowerCase())
  return false
}

function isPublicV4(address: string): boolean {
  const octets = address.split('.').map(Number)
  const [a, b] = octets
  if (octets.length !== 4 || a === undefined || b === undefined) return false
  if (a === 0) return false // "this network"
  if (a === 10) return false // private
  if (a === 127) return false // loopback
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local, including the metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return false // private
  if (a === 192 && b === 0) return false // IETF protocol assignments and TEST-NET-1
  if (a === 192 && b === 168) return false // private
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51) return false // TEST-NET-2
  if (a === 203 && b === 0) return false // TEST-NET-3
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

function isPublicV6(address: string): boolean {
  // An IPv4-mapped or IPv4-embedded address is only as public as the IPv4 address inside it.
  const embedded = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(address)
  if (embedded?.[1] !== undefined) return isPublicV4(embedded[1])

  const groups = expandV6(address)
  if (groups === undefined) return false
  const [first = 0, second = 0] = groups
  if (groups.every((group) => group === 0)) return false // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false // ::1
  if ((first & 0xfe00) === 0xfc00) return false // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false // multicast
  if (first === 0x0064 && second === 0xff9b) return false // NAT64, wraps an IPv4 destination
  if (first === 0x0100) return false // discard-only 100::/64
  if (first === 0x2001 && second <= 0x01ff) return false // teredo and IETF protocol assignments
  if (first === 0x2002) return false // 6to4, wraps an IPv4 destination
  return true
}

/** The eight groups of an IPv6 address, or undefined if it is not one we understand. */
function expandV6(address: string): number[] | undefined {
  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16))
  const head = parse(halves[0] ?? '')
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : []
  const groups =
    halves.length === 2
      ? [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail]
      : head
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return undefined
  return groups
}
