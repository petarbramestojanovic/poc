import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config.ts'

const TOKEN = 'a-long-enough-operator-token-0123456789'

const valid = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SERVICE_ADMIN_TOKEN: TOKEN,
  TZ: 'UTC',
}

describe('loadConfig', () => {
  it('parses a valid environment with secure defaults', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      databaseSsl: 'verify-full',
      databaseSslCa: undefined,
      adminToken: TOKEN,
      port: 3000,
      logLevel: 'info',
      trustProxyHops: 0,
    })
  })

  it('coerces PORT and TRUST_PROXY_HOPS and accepts LOG_LEVEL', () => {
    const config = loadConfig({ ...valid, PORT: '8080', LOG_LEVEL: 'debug', TRUST_PROXY_HOPS: '2' })
    expect(config.port).toBe(8080)
    expect(config.logLevel).toBe('debug')
    expect(config.trustProxyHops).toBe(2)
  })

  it('ignores unrelated variables and empty values', () => {
    expect(() => loadConfig({ ...valid, NEXD_API_KEY: '', HOME: '/x' })).not.toThrow()
  })

  it('allows DATABASE_SSL=disable for a loopback host only', () => {
    expect(loadConfig({ ...valid, DATABASE_SSL: 'disable' }).databaseSsl).toBe('disable')
    expect(
      loadConfig({
        ...valid,
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        DATABASE_SSL: 'disable',
      }).databaseSsl,
    ).toBe('disable')
  })

  it.each([
    ['DATABASE_URL missing', { ...valid, DATABASE_URL: undefined }, 'DATABASE_URL'],
    ['DATABASE_URL not postgres', { ...valid, DATABASE_URL: 'https://x' }, 'DATABASE_URL'],
    [
      'TLS disabled for a remote host',
      {
        ...valid,
        DATABASE_URL: 'postgresql://u:p@db.example.com:5432/db',
        DATABASE_SSL: 'disable',
      },
      'loopback',
    ],
    [
      'the transaction-mode pooler',
      { ...valid, DATABASE_URL: 'postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres' },
      'transaction-mode',
    ],
    ['DATABASE_SSL unknown', { ...valid, DATABASE_SSL: 'require' }, 'DATABASE_SSL'],
    [
      'admin token too short',
      { ...valid, SERVICE_ADMIN_TOKEN: 'sixteen-chars-xx' },
      '32 characters',
    ],
    ['PORT not a number', { ...valid, PORT: 'abc' }, 'PORT'],
    ['PORT out of range', { ...valid, PORT: '70000' }, 'PORT'],
    ['TRUST_PROXY_HOPS not a number', { ...valid, TRUST_PROXY_HOPS: 'yes' }, 'TRUST_PROXY_HOPS'],
    ['LOG_LEVEL unknown', { ...valid, LOG_LEVEL: 'loud' }, 'LOG_LEVEL'],
    ['TZ not UTC', { ...valid, TZ: 'Europe/Zurich' }, 'must be UTC'],
    ['TZ missing', { ...valid, TZ: undefined }, 'TZ'],
  ])('rejects %s', (_name, env, message) => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(ConfigError)
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(message)
  })
})
