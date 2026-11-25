import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  loadConfig,
  loadMailConfig,
  loadRuntimeConfig,
} from '../../src/core/config.ts'

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
      syncSchedulerEnabled: true,
      webhookSchedulerEnabled: true,
      emailReportSchedulerEnabled: true,
      pageTracking: { combinationCap: 2000 },
    })
  })

  it('reads the page tracker limit, and refuses one that is not a positive whole number', () => {
    expect(loadConfig({ ...valid, PAGE_COMBINATION_CAP: '500' }).pageTracking).toEqual({
      combinationCap: 500,
    })
    for (const bad of ['0', '-1', '1.5', 'many']) {
      expect(() => loadConfig({ ...valid, PAGE_COMBINATION_CAP: bad })).toThrow(
        'PAGE_COMBINATION_CAP',
      )
    }
  })

  it('coerces PORT and TRUST_PROXY_HOPS and accepts LOG_LEVEL', () => {
    const config = loadConfig({ ...valid, PORT: '8080', LOG_LEVEL: 'debug', TRUST_PROXY_HOPS: '2' })
    expect(config.port).toBe(8080)
    expect(config.logLevel).toBe('debug')
    expect(config.trustProxyHops).toBe(2)
  })

  it('reads SYNC_SCHEDULER_ENABLED as a boolean, on by default', () => {
    expect(loadConfig(valid).syncSchedulerEnabled).toBe(true)
    expect(loadConfig({ ...valid, SYNC_SCHEDULER_ENABLED: 'false' }).syncSchedulerEnabled).toBe(
      false,
    )
    expect(() => loadConfig({ ...valid, SYNC_SCHEDULER_ENABLED: 'maybe' })).toThrow(
      'SYNC_SCHEDULER_ENABLED',
    )
  })

  it('reads EMAIL_REPORT_SCHEDULER_ENABLED as a boolean, on by default', () => {
    expect(loadConfig(valid).emailReportSchedulerEnabled).toBe(true)
    expect(
      loadConfig({ ...valid, EMAIL_REPORT_SCHEDULER_ENABLED: 'false' }).emailReportSchedulerEnabled,
    ).toBe(false)
    expect(() => loadConfig({ ...valid, EMAIL_REPORT_SCHEDULER_ENABLED: 'sometimes' })).toThrow(
      'EMAIL_REPORT_SCHEDULER_ENABLED',
    )
  })

  it('reads the deployed commit from RENDER_GIT_COMMIT, absent locally', () => {
    const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1'
    expect(loadConfig({ ...valid, RENDER_GIT_COMMIT: sha }).commit).toBe(sha)
    expect(loadConfig({ ...valid, RENDER_GIT_COMMIT: '' })).not.toHaveProperty('commit')
    expect(() => loadConfig({ ...valid, RENDER_GIT_COMMIT: 'main; rm -rf' })).toThrow(
      'RENDER_GIT_COMMIT',
    )
  })

  it('reads OPENROUTER_API_KEY, absent unless set: the industry LLM is then off', () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789'
    expect(loadConfig(valid)).not.toHaveProperty('openRouterApiKey')
    expect(loadConfig({ ...valid, OPENROUTER_API_KEY: '' })).not.toHaveProperty('openRouterApiKey')
    expect(loadConfig({ ...valid, OPENROUTER_API_KEY: ` ${key}\n` }).openRouterApiKey).toBe(key)
  })

  it('refuses an OPENROUTER_API_KEY too short to be one, without quoting it', () => {
    const short = 'sk-or-tiny'
    expect(() => loadConfig({ ...valid, OPENROUTER_API_KEY: short })).toThrow('OPENROUTER_API_KEY')
    expect(() => loadConfig({ ...valid, OPENROUTER_API_KEY: short })).not.toThrow(short)
  })

  it('reads INBOUND_CAMPAIGNS_TOKEN, absent unless set', () => {
    const inbound = 'another-long-enough-inbound-token-0123456789'
    expect(loadConfig(valid)).not.toHaveProperty('inboundCampaignsToken')
    expect(loadConfig({ ...valid, INBOUND_CAMPAIGNS_TOKEN: '' })).not.toHaveProperty(
      'inboundCampaignsToken',
    )
    expect(loadConfig({ ...valid, INBOUND_CAMPAIGNS_TOKEN: inbound }).inboundCampaignsToken).toBe(
      inbound,
    )
  })

  it.each([
    ['shorter than 32 characters', 'sixteen-chars-xx', 'at least 32'],
    ['the admin token again', TOKEN, 'must differ from SERVICE_ADMIN_TOKEN'],
  ])('rejects an INBOUND_CAMPAIGNS_TOKEN that is %s', (_name, value, message) => {
    expect(() => loadConfig({ ...valid, INBOUND_CAMPAIGNS_TOKEN: value })).toThrow(message)
  })

  it("reads PUBLIC_BASE_URL as an origin, falling back to Render's own address", () => {
    const render = 'https://poc-guf1.onrender.com'
    expect(loadConfig(valid)).not.toHaveProperty('publicBaseUrl')
    expect(loadConfig({ ...valid, RENDER_EXTERNAL_URL: render }).publicBaseUrl).toBe(render)
    expect(
      loadConfig({
        ...valid,
        RENDER_EXTERNAL_URL: render,
        PUBLIC_BASE_URL: 'https://analytics.example.com/',
      }).publicBaseUrl,
    ).toBe('https://analytics.example.com')
    expect(loadConfig({ ...valid, PUBLIC_BASE_URL: 'http://localhost:3000' }).publicBaseUrl).toBe(
      'http://localhost:3000',
    )
  })

  it('ignores a RENDER_EXTERNAL_URL it cannot use, rather than refusing to boot', () => {
    expect(
      loadConfig({ ...valid, RENDER_EXTERNAL_URL: 'https://poc-guf1.onrender.com/app' }),
    ).not.toHaveProperty('publicBaseUrl')
  })

  it.each([
    ['plain http', 'http://analytics.example.com', 'must be https'],
    ['a path', 'https://analytics.example.com/api', 'origin only'],
    ['a query', 'https://analytics.example.com/?x=1', 'origin only'],
    ['another scheme', 'ftp://analytics.example.com', 'PUBLIC_BASE_URL'],
  ])('rejects a PUBLIC_BASE_URL with %s', (_name, value, message) => {
    expect(() => loadConfig({ ...valid, PUBLIC_BASE_URL: value })).toThrow(message)
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

describe('mail settings', () => {
  const RESEND_KEY = 're_test_0123456789abcdef'
  const resend = {
    MAIL_PROVIDER: 'resend',
    RESEND_API_KEY: RESEND_KEY,
    MAIL_FROM: 'Klea Analytics <analytics@reports.example.com>',
  }

  it('leaves email off when MAIL_PROVIDER is not set, whatever else is', () => {
    expect(loadConfig(valid)).not.toHaveProperty('mail')
    expect(
      loadConfig({ ...valid, MAIL_FROM: 'r@example.com', RESEND_API_KEY: RESEND_KEY }),
    ).not.toHaveProperty('mail')
    expect(loadConfig({ ...valid, MAIL_PROVIDER: '' })).not.toHaveProperty('mail')
    expect(loadMailConfig({})).toBeUndefined()
  })

  it('reads Resend with its key, the sender and an optional reply-to', () => {
    expect(loadConfig({ ...valid, ...resend }).mail).toEqual({
      provider: { name: 'resend', apiKey: RESEND_KEY },
      from: 'Klea Analytics <analytics@reports.example.com>',
    })
    expect(loadMailConfig({ ...resend, MAIL_REPLY_TO: 'team@example.com' })).toEqual({
      provider: { name: 'resend', apiKey: RESEND_KEY },
      from: 'Klea Analytics <analytics@reports.example.com>',
      replyTo: 'team@example.com',
    })
  })

  it('normalises the sender and needs no key for the memory provider', () => {
    expect(
      loadMailConfig({ MAIL_PROVIDER: 'memory', MAIL_FROM: '  Klea  <r@example.com> ' }),
    ).toEqual({
      provider: { name: 'memory' },
      from: 'Klea <r@example.com>',
    })
  })

  it.each([
    ['an unknown provider', { MAIL_PROVIDER: 'sendgrid' }, 'MAIL_PROVIDER'],
    ['no sender', { MAIL_PROVIDER: 'resend', RESEND_API_KEY: RESEND_KEY }, 'MAIL_FROM'],
    [
      'Resend without its key',
      { MAIL_PROVIDER: 'resend', MAIL_FROM: 'r@example.com' },
      'RESEND_API_KEY',
    ],
    [
      'a key that is not a Resend key',
      { ...resend, RESEND_API_KEY: 'sk_live_abc' },
      'starts with re_',
    ],
    [
      'a Gmail-style display name with a comma',
      { ...resend, MAIL_FROM: 'Klea, Analytics <r@example.com>' },
      'MAIL_FROM',
    ],
    ['a sender that is not an address', { ...resend, MAIL_FROM: 'Klea Analytics' }, 'MAIL_FROM'],
    [
      'two reply-to addresses',
      { ...resend, MAIL_REPLY_TO: 'a@example.com, b@example.com' },
      'MAIL_REPLY_TO',
    ],
  ])('refuses to boot with %s', (_name, mail, message) => {
    expect(() => loadConfig({ ...valid, ...mail })).toThrow(ConfigError)
    expect(() => loadConfig({ ...valid, ...mail })).toThrow(message)
    expect(() => loadMailConfig(mail)).toThrow(message)
  })

  it('never puts the key in a refusal', () => {
    const secret = 'not-a-resend-key-but-secret'
    const error = (() => {
      try {
        loadConfig({ ...valid, ...resend, RESEND_API_KEY: secret })
      } catch (e) {
        return e as Error
      }
      return undefined
    })()
    expect(error?.message).toContain('RESEND_API_KEY')
    expect(error?.message).not.toContain(secret)
  })
})

describe('loadRuntimeConfig', () => {
  it('needs only the database, log level and TZ, never the admin token', () => {
    expect(loadRuntimeConfig({ DATABASE_URL: valid.DATABASE_URL, TZ: 'UTC' })).toEqual({
      databaseUrl: valid.DATABASE_URL,
      databaseSsl: 'verify-full',
      databaseSslCa: undefined,
      logLevel: 'info',
    })
  })

  it('reads OPENROUTER_API_KEY too, for the industry backfill', () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789'
    const base = { DATABASE_URL: valid.DATABASE_URL, TZ: 'UTC' }
    expect(loadRuntimeConfig(base)).not.toHaveProperty('openRouterApiKey')
    expect(loadRuntimeConfig({ ...base, OPENROUTER_API_KEY: key }).openRouterApiKey).toBe(key)
  })

  it('applies the same database checks as the service', () => {
    expect(() =>
      loadRuntimeConfig({
        DATABASE_URL: 'postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres',
        TZ: 'UTC',
      }),
    ).toThrow('transaction-mode')
    expect(() =>
      loadRuntimeConfig({
        DATABASE_URL: 'postgresql://u:p@db.example.com:5432/db',
        DATABASE_SSL: 'disable',
        TZ: 'UTC',
      }),
    ).toThrow('loopback')
  })
})
