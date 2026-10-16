import { z } from 'zod'
import { externalRefSchema } from '../../core/external-ref.ts'

/** An existing company by our id, or a company described well enough to create or find it. */
export const companyRefSchema = z.union([
  z.strictObject({ id: z.guid() }),
  z.strictObject({
    name: z.string().trim().min(1).max(200),
    externalRef: externalRefSchema.optional(),
  }),
])
export type CompanyRef = z.infer<typeof companyRefSchema>
