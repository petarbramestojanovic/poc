import { z } from 'zod'
import {
  buildReport,
  incompleteCampaigns,
  renderReport,
  type ReportTarget,
} from '../../webhooks/build.ts'
import { InvalidFormulaError, WebhookError } from '../../webhooks/errors.ts'
import {
  fieldWarnings,
  loadScopes,
  payloadFieldsSchema,
  readStoredFields,
  validateFields,
  type CompiledFields,
} from '../../webhooks/fields.ts'
import { FORMATS, type Format } from '../../webhooks/payload.ts'
import { InvalidEmailReportError } from '../errors.ts'
import type { PreparedReport, ReportKind, ReportScope } from './index.ts'

// The flat rows of a webhook, as a file: the same column list (src/modules/webhooks/fields.ts), the
// same builder and the same renderer as a webhook, so an email report and a webhook with the same
// columns attach and send the same file. Nothing here builds rows itself.
//
// settings: { format: 'csv' | 'json' (default csv), fields: a webhook column list }

const CONTENT_TYPES: Readonly<Record<Format, string>> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
}

export const rowsSettingsSchema = z.strictObject({
  format: z.enum(FORMATS).default('csv'),
  fields: payloadFieldsSchema,
})

export type RowsSettings = z.infer<typeof rowsSettingsSchema>

/** A webhook's errors in the email report family; a formula error keeps its own code. */
function asReportError(error: unknown): unknown {
  if (error instanceof InvalidFormulaError) return error
  if (error instanceof WebhookError && error.status < 500) {
    return new InvalidEmailReportError(error.message, { cause: error })
  }
  return error
}

function parse(input: unknown, what: string): RowsSettings {
  const parsed = rowsSettingsSchema.safeParse(input)
  if (!parsed.success) {
    throw new InvalidEmailReportError(`${what}: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

function targetOf(scope: ReportScope, format: Format): ReportTarget {
  return {
    id: scope.id,
    companyId: scope.companyId,
    campaignIds: scope.campaignIds,
    timezone: scope.timezone,
    frequency: scope.frequency,
    format,
  }
}

export const rowsKind: ReportKind = {
  async validate(q, input, scope) {
    const settings = parse(input, 'settings')
    let compiled: CompiledFields
    try {
      compiled = await validateFields(q, settings.fields)
    } catch (error) {
      throw asReportError(error)
    }
    const scopes = await loadScopes(q, compiled, scope.companyId, scope.campaignIds)
    return { settings, warnings: fieldWarnings(compiled, scopes) }
  },

  prepare(stored): PreparedReport {
    const settings = parse(stored, 'stored settings')
    let fields: CompiledFields
    try {
      fields = readStoredFields(settings.fields)
    } catch (error) {
      throw asReportError(error)
    }
    const { format } = settings

    return {
      // Only the first row set's source holds a report back, as for a webhook.
      incomplete: (q, scope, period) =>
        incompleteCampaigns(q, targetOf(scope, format), fields.waitSource, period),

      async build(q, scope, period, deliveryId, generatedAt, log) {
        const target = targetOf(scope, format)
        const report = await buildReport(q, target, period, fields, log)
        return {
          document: renderReport(target, period, report, deliveryId, generatedAt),
          contentType: CONTENT_TYPES[format],
          rowCount: report.rows.length,
        }
      },
    }
  },
}
