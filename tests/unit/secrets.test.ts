import { describe, expect, it } from 'vitest'
import {
  assertSecretPointer,
  InvalidSecretPointerError,
  MissingSecretError,
  resolveSecret,
} from '../../src/secrets.ts'

describe('resolveSecret', () => {
  it('returns the value of the named variable', () => {
    expect(resolveSecret('NEXD_API_KEY', { NEXD_API_KEY: 'k' })).toBe('k')
    expect(resolveSecret('ZEUS_API_TOKEN', { ZEUS_API_TOKEN: 't' })).toBe('t')
  })

  it('throws a typed error naming the variable when unset or empty', () => {
    expect(() => resolveSecret('ZEUS_API_TOKEN', {})).toThrow(MissingSecretError)
    expect(() => resolveSecret('ZEUS_API_TOKEN', { ZEUS_API_TOKEN: '' })).toThrow('ZEUS_API_TOKEN')
  })

  it.each([
    ['one of our own secrets', 'DATABASE_URL'],
    ['the operator token', 'SERVICE_ADMIN_TOKEN'],
    ['an unrelated variable', 'HOME'],
    ['lower case', 'nexd_api_key'],
    ['no credential suffix', 'NEXD_ENDPOINT'],
  ])('refuses to dereference %s', (_name, pointer) => {
    const env = { [pointer]: 'must-not-leak' }
    expect(() => resolveSecret(pointer, env)).toThrow(InvalidSecretPointerError)
  })

  it('accepts third-party credential shapes', () => {
    for (const pointer of ['ADNUNTIUS_API_KEY', 'ADFORM_CLIENT_SECRET', 'CM360_TOKEN', 'X2_KEY']) {
      expect(assertSecretPointer(pointer)).toBe(pointer)
    }
  })
})
