import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/core/log.ts'

function capture() {
  const lines: string[] = []
  const logger = createLogger('info', {
    write: (line: string) => {
      lines.push(line)
    },
  })
  const last = () => JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>
  return { logger, last, lines }
}

describe('logger redaction', () => {
  it('masks every path it claims to cover', () => {
    const { logger, last } = capture()
    logger.info(
      {
        req: { headers: { authorization: 'Bearer r1', cookie: 'sid=r2' } },
        res: { headers: { 'set-cookie': 'sid=r3' } },
        headers: { authorization: 'Bearer r4', cookie: 'r5' },
        request: { headers: { authorization: 'Bearer r6' } },
        credential: { id: 'c1', secret: 'r7' },
        config: {
          port: 1,
          databaseUrl: 'postgresql://u:r8@h/db',
          adminToken: 'r9',
          databaseSslCa: 'r10',
        },
        webhook: { id: 'w1', secret: 'r11', authToken: 'r25', auth_token: 'r26' },
        authorization: 'Bearer r12',
        secret: 'r13',
        token: 'r14',
        apiKey: 'r15',
        api_key: 'r16',
        password: 'r17',
        databaseUrl: 'r18',
        adminToken: 'r19',
        // A client's own key for its webhook endpoint (migration 0008).
        authToken: 'r20',
        auth_token: 'r21',
        auth: { header: 'x-funnel-fileimport-token', token: 'r22' },
        delivery: { id: 'd1', authToken: 'r23', auth_token: 'r24' },
      },
      'probe',
    )
    const serialised = JSON.stringify(last())
    for (let i = 1; i <= 26; i++)
      expect(serialised, `r${i} leaked`).not.toMatch(new RegExp(`\\br${i}\\b`))
    const entry = last() as {
      credential: { id: string }
      config: { port: number }
      webhook: { id: string }
      auth: { header: string }
    }
    // Non-secret siblings survive.
    expect(entry.auth.header).toBe('x-funnel-fileimport-token')
    expect(entry.credential.id).toBe('c1')
    expect(entry.config.port).toBe(1)
    expect(entry.webhook.id).toBe('w1')
  })
})
