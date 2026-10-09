import { describe, expect, it } from 'vitest'
import { BlockedTargetError } from '../../src/modules/webhooks/errors.ts'
import {
  assertPublicTarget,
  isPublicAddress,
  type Lookup,
} from '../../src/modules/webhooks/ssrf.ts'

// The guard exists for one attack: a webhook URL aimed back at our own network — the cloud
// metadata endpoint, a private subnet, localhost. Every case here is one of those.

const resolvesTo =
  (...addresses: string[]): Lookup =>
  () =>
    Promise.resolve(addresses.map((address) => ({ address })))

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '1.1.1.1',
    '172.32.0.1', // just outside the private 172.16/12 block
    '100.128.0.1', // just outside carrier-grade NAT
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8', // IPv4-mapped public, dotted
    '::ffff:808:808', // the same address in hex
  ])('accepts the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.10.20.30', 'loopback'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    // The URL parser writes a mapped literal in hex, so hex must be judged by the IPv4 inside.
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata, hex'],
    ['::ffff:a00:1', 'IPv4-mapped private, hex'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['::7f00:1', 'IPv4-compatible loopback, hex'],
    ['fe80::1.2.3.4', 'link-local with a dotted tail'],
    ['fc00::8.8.8.8', 'unique local with a public-looking dotted tail'],
    ['2001:db8::1', 'documentation'],
    ['4000::1', 'outside global unicast'],
    ['64:ff9b::169.254.169.254', 'NAT64-wrapped metadata'],
    ['2002:7f00:1::', '6to4'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it('refuses anything that is not an IP address', () => {
    expect(isPublicAddress('example.com')).toBe(false)
    expect(isPublicAddress('')).toBe(false)
    expect(isPublicAddress('999.1.1.1')).toBe(false)
  })
})

describe('assertPublicTarget', () => {
  it('accepts a host that resolves to a public address', async () => {
    await expect(
      assertPublicTarget('https://client.example.com/hook', resolvesTo('93.184.216.34')),
    ).resolves.toBeUndefined()
  })

  it('refuses plain http', async () => {
    await expect(
      assertPublicTarget('http://client.example.com/hook', resolvesTo('93.184.216.34')),
    ).rejects.toBeInstanceOf(BlockedTargetError)
  })

  it('refuses a loopback literal without asking DNS', async () => {
    const never: Lookup = () => Promise.reject(new Error('DNS must not be consulted'))
    await expect(assertPublicTarget('https://127.0.0.1:8080/hook', never)).rejects.toThrow(
      /127\.0\.0\.1/,
    )
    await expect(assertPublicTarget('https://[::1]/hook', never)).rejects.toBeInstanceOf(
      BlockedTargetError,
    )
  })

  it.each([
    'https://[::ffff:127.0.0.1]/hook',
    'https://[::ffff:169.254.169.254]/latest/meta-data/',
    'https://[::ffff:10.0.0.1]/hook',
    'https://[::127.0.0.1]/hook',
    'https://[fe80::1.2.3.4]/hook',
  ])('refuses the IPv6 literal in %s, however the URL parser rewrites it', async (url) => {
    const never: Lookup = () => Promise.reject(new Error('DNS must not be consulted'))
    await expect(assertPublicTarget(url, never)).rejects.toBeInstanceOf(BlockedTargetError)
  })

  it('refuses a host that resolves to the metadata endpoint', async () => {
    await expect(
      assertPublicTarget('https://evil.example.com/hook', resolvesTo('169.254.169.254')),
    ).rejects.toThrow(/169\.254\.169\.254/)
  })

  it('refuses when only one of several answers is private', async () => {
    // A split answer is the classic bypass: one public address to pass the check, one private to
    // connect to.
    await expect(
      assertPublicTarget('https://evil.example.com/hook', resolvesTo('93.184.216.34', '10.0.0.5')),
    ).rejects.toBeInstanceOf(BlockedTargetError)
  })

  it('refuses a host that does not resolve at all', async () => {
    await expect(
      assertPublicTarget('https://gone.example.com/hook', resolvesTo()),
    ).rejects.toBeInstanceOf(BlockedTargetError)
    await expect(
      assertPublicTarget('https://gone.example.com/hook', () =>
        Promise.reject(new Error('ENOTFOUND')),
      ),
    ).rejects.toBeInstanceOf(BlockedTargetError)
  })

  it('refuses a string that is not a URL', async () => {
    await expect(assertPublicTarget('not a url', resolvesTo('8.8.8.8'))).rejects.toBeInstanceOf(
      BlockedTargetError,
    )
  })
})
