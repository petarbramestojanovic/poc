import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config.ts'

const valid = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SERVICE_ADMIN_TOKEN: 'a-long-enough-operator-token',
  TZ: 'UTC',
}

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      adminToken: valid.SERVICE_ADMIN_TOKEN,
      port: 3000,
      logLevel: 'info',
    })
  })

  it('coerces PORT and accepts LOG_LEVEL', () => {
    const config = loadConfig({ ...valid, PORT: '8080', LOG_LEVEL: 'debug' })
    expect(config.port).toBe(8080)
    expect(config.logLevel).toBe('debug')
  })

  it('ignores unrelated variables and empty values', () => {
    expect(() => loadConfig({ ...valid, NEXD_API_KEY: '', HOME: '/x' })).not.toThrow()
  })

  it.each([
    ['DATABASE_URL missing', { ...valid, DATABASE_URL: undefined }, 'DATABASE_URL'],
    ['DATABASE_URL not postgres', { ...valid, DATABASE_URL: 'https://x' }, 'DATABASE_URL'],
    ['admin token too short', { ...valid, SERVICE_ADMIN_TOKEN: 'short' }, '16 characters'],
    ['PORT not a number', { ...valid, PORT: 'abc' }, 'PORT'],
    ['PORT out of range', { ...valid, PORT: '70000' }, 'PORT'],
    ['LOG_LEVEL unknown', { ...valid, LOG_LEVEL: 'loud' }, 'LOG_LEVEL'],
    ['TZ not UTC', { ...valid, TZ: 'Europe/Zurich' }, 'must be UTC'],
    ['TZ missing', { ...valid, TZ: undefined }, 'TZ'],
  ])('rejects %s', (_name, env, message) => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(ConfigError)
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(message)
  })
})
