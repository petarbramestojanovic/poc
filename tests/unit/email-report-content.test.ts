import { describe, expect, it } from 'vitest'
import { checkRecipients } from '../../src/modules/email-reports/admin.ts'
import {
  attachmentName,
  emailFor,
  extensionOf,
  idempotencyKeyFor,
  periodLabel,
  slug,
} from '../../src/modules/email-reports/content.ts'
import { InvalidEmailReportError } from '../../src/modules/email-reports/errors.ts'
import { kindOf } from '../../src/modules/email-reports/kinds/index.ts'
import { rowsSettingsSchema } from '../../src/modules/email-reports/kinds/rows.ts'

const DAY = { from: '2026-11-14', to: '2026-11-14' }
const WEEK = { from: '2026-11-09', to: '2026-11-15' }
const CSV = 'Date,Campaign\r\n2026-11-14,Grüezi\r\n'

describe('email content', () => {
  it('names a day by its date and a range by its ends', () => {
    expect(periodLabel(DAY)).toBe('2026-11-14')
    expect(periodLabel(WEEK)).toBe('2026-11-09 to 2026-11-15')
  })

  it.each([
    ['Tchibo Always-on', 'tchibo-always-on'],
    ['Müller & Söhne / DE', 'muller-sohne-de'],
    ['  --  ', 'report'],
    ['日本語', 'report'],
    ['x'.repeat(80), 'x'.repeat(60)],
  ])('slugs %j as %j', (name, expected) => {
    expect(slug(name)).toBe(expected)
  })

  it('names the attachment after the report, the period and the format', () => {
    expect(attachmentName('Tchibo Always-on', DAY, 'csv')).toBe('tchibo-always-on_2026-11-14.csv')
    expect(attachmentName('Tchibo Always-on', WEEK, 'json')).toBe(
      'tchibo-always-on_2026-11-09_2026-11-15.json',
    )
    expect(extensionOf('text/csv; charset=utf-8')).toBe('csv')
    expect(extensionOf('application/json; charset=utf-8')).toBe('json')
    expect(extensionOf('application/pdf')).toBe('txt')
  })

  it('builds one plain-text email with the stored file attached as it is', () => {
    const email = emailFor(
      { name: 'Tchibo Always-on', timezone: 'Europe/Zurich' },
      ['anna@example.com', 'ben@example.com'],
      DAY,
      CSV,
      'text/csv; charset=utf-8',
    )
    expect(email).toEqual({
      to: ['anna@example.com', 'ben@example.com'],
      subject: 'Tchibo Always-on, 2026-11-14',
      text: 'Attached is the report "Tchibo Always-on" for 2026-11-14 (Europe/Zurich).\n\nThis email is sent automatically.',
      attachments: [
        {
          filename: 'tchibo-always-on_2026-11-14.csv',
          contentType: 'text/csv; charset=utf-8',
          content: CSV,
        },
      ],
    })
  })

  it('keys an unchanged email the same way on every attempt, and a changed one differently', () => {
    const id = '7b0f7f3e-8e4b-4c38-9d0e-1c2b3a4d5e6f'
    const email = (to: string[], document: string, name = 'Report') =>
      emailFor({ name, timezone: 'Europe/Zurich' }, to, DAY, document, 'text/csv; charset=utf-8')
    const key = idempotencyKeyFor(id, email(['a@example.com'], CSV))

    expect(key).toMatch(new RegExp(`^${id}:[0-9a-f]{16}$`))
    expect(idempotencyKeyFor(id, email(['a@example.com'], CSV))).toBe(key)
    // A rebuilt file, another recipient list, a renamed report: each a new key.
    expect(idempotencyKeyFor(id, email(['a@example.com'], `${CSV}x`))).not.toBe(key)
    expect(idempotencyKeyFor(id, email(['b@example.com'], CSV))).not.toBe(key)
    expect(idempotencyKeyFor(id, email(['a@example.com'], CSV, 'Renamed'))).not.toBe(key)
    // Another delivery of the same email.
    expect(idempotencyKeyFor('another-id', email(['a@example.com'], CSV))).not.toBe(key)
  })
})

describe('recipients', () => {
  it('keeps the list trimmed and in order', () => {
    expect(checkRecipients([' anna@example.com ', 'ben@example.com'])).toEqual([
      'anna@example.com',
      'ben@example.com',
    ])
  })

  it.each([
    ['none', [], 'at least one'],
    ['21', Array.from({ length: 21 }, (_, i) => `r${i}@example.com`), 'at most 20'],
    ['a malformed one', ['anna@example.com', 'ben'], 'recipients[1] is not an email address'],
    [
      'one twice, ignoring case',
      ['anna@example.com', 'Anna@Example.com'],
      'recipients[1] is listed twice',
    ],
  ])('refuses %s, without quoting an address', (_name, list, message) => {
    expect(() => checkRecipients(list)).toThrow(InvalidEmailReportError)
    expect(() => checkRecipients(list)).toThrow(message)
    try {
      checkRecipients(list)
    } catch (error) {
      expect((error as Error).message).not.toContain('@')
    }
  })
})

describe('report kinds', () => {
  it('knows rows and refuses anything else', () => {
    expect(kindOf('rows')).toBeDefined()
    expect(() => kindOf('pdf')).toThrow(InvalidEmailReportError)
    expect(() => kindOf('__proto__')).toThrow('unknown report kind')
  })

  it('stores rows settings as csv unless json is asked for', () => {
    const fields = { source: 'zeus', columns: [{ name: 'Impressions', formula: 'impressions' }] }
    expect(rowsSettingsSchema.parse({ fields }).format).toBe('csv')
    expect(rowsSettingsSchema.parse({ format: 'json', fields }).format).toBe('json')
    expect(rowsSettingsSchema.safeParse({ fields, extra: 1 }).success).toBe(false)
  })

  it('refuses stored settings edited by hand as an email report error', () => {
    const rows = kindOf('rows')
    expect(() => rows.prepare({ format: 'pdf' })).toThrow(InvalidEmailReportError)
    expect(() => rows.prepare(null)).toThrow(InvalidEmailReportError)
    expect(() => rows.prepare({ format: 'csv', fields: { columns: [], rows: [] } })).toThrow(
      InvalidEmailReportError,
    )
  })
})
