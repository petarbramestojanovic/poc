import { describe, expect, it } from 'vitest'
import { MissingSecretError, resolveSecret } from '../../src/secrets.ts'

describe('resolveSecret', () => {
  it('returns the value of the named variable', () => {
    expect(resolveSecret('NEXD_API_KEY', { NEXD_API_KEY: 'k' })).toBe('k')
  })

  it('throws a typed error naming the variable when unset or empty', () => {
    expect(() => resolveSecret('ZEUS_API_TOKEN', {})).toThrow(MissingSecretError)
    expect(() => resolveSecret('ZEUS_API_TOKEN', { ZEUS_API_TOKEN: '' })).toThrow('ZEUS_API_TOKEN')
  })
})
