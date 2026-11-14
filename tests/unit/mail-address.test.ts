import { describe, expect, it } from 'vitest'
import {
  formatSender,
  isEmailAddress,
  parseSender,
  scrubAddresses,
} from '../../src/core/mail/address.ts'

describe('isEmailAddress', () => {
  it.each([
    'anna@example.com',
    'anna.berger+reports@mail.example.co.uk',
    'ANNA@EXAMPLE.COM',
    "o'neil@example.com",
    'a@b-c.example',
  ])('accepts %s', (address) => {
    expect(isEmailAddress(address)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['no @', 'anna.example.com'],
    ['no local part', '@example.com'],
    ['no top-level domain', 'anna@localhost'],
    ['a numeric top-level domain', 'anna@10.0.0.1'],
    ['a leading dot', '.anna@example.com'],
    ['two dots in a row', 'anna..b@example.com'],
    ['a space', 'anna b@example.com'],
    ['a display name', 'Anna <anna@example.com>'],
    ['two addresses', 'anna@example.com,ben@example.com'],
    ['a line break (header injection)', 'anna@example.com\r\nBcc: x@example.com'],
    ['a hyphen at the end of a label', 'anna@example-.com'],
    ['a local part over 64 characters', `${'a'.repeat(65)}@example.com`],
    ['over 254 characters', `anna@${'a'.repeat(250)}.com`],
  ])('refuses %s', (_name, address) => {
    expect(isEmailAddress(address)).toBe(false)
  })
})

describe('parseSender', () => {
  it('reads an address alone and a display name with an address', () => {
    expect(parseSender('reports@example.com')).toEqual({ address: 'reports@example.com' })
    expect(parseSender('Klea Analytics <reports@example.com>')).toEqual({
      name: 'Klea Analytics',
      address: 'reports@example.com',
    })
    expect(parseSender('  Klea   Analytics  <reports@example.com> ')).toEqual({
      name: 'Klea   Analytics',
      address: 'reports@example.com',
    })
    expect(parseSender('<reports@example.com>')).toEqual({ address: 'reports@example.com' })
  })

  it.each([
    ['a quote in the name', '"Klea" <reports@example.com>'],
    [
      'a comma in the name, which would start a second address',
      'Klea, Analytics <reports@example.com>',
    ],
    ['a line break in the name', 'Klea\r\nBcc: x <reports@example.com>'],
    ['a bad address', 'Klea <reports>'],
    ['two angle brackets', 'Klea <<reports@example.com>>'],
    ['a name without an address', 'Klea Analytics'],
  ])('refuses %s', (_name, value) => {
    expect(parseSender(value)).toBeUndefined()
  })

  it('formats a sender back to one header value', () => {
    expect(formatSender({ name: 'Klea Analytics', address: 'r@example.com' })).toBe(
      'Klea Analytics <r@example.com>',
    )
    expect(formatSender({ address: 'r@example.com' })).toBe('r@example.com')
  })
})

describe('scrubAddresses', () => {
  it('replaces every address in a provider message and keeps the rest', () => {
    expect(
      scrubAddresses(
        'You can only send testing emails to your own email address (owner@gmail.com). Not to `anna.b+x@mail.example.co.uk`.',
      ),
    ).toBe(
      'You can only send testing emails to your own email address ([address]). Not to `[address]`.',
    )
    expect(scrubAddresses('The `example.com` domain is not verified.')).toBe(
      'The `example.com` domain is not verified.',
    )
  })
})
