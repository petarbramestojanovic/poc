import { z } from 'zod'
import { externalRefSchema } from '../../core/external-ref.ts'

/** An existing company by our id, or a company described well enough to create or find it. */
export const companyRefSchema = z.union([
  z.strictObject({ id: z.guid() }),
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      externalRef: externalRefSchema.optional(),
      /**
       * The reference the same system knew this company by before it had `externalRef`. A company
       * found under it, and not yet under `externalRef`, is moved to `externalRef` (resolveCompany).
       */
      formerRef: externalRefSchema.optional(),
    })
    .refine((ref) => ref.formerRef === undefined || ref.externalRef !== undefined, {
      error: 'formerRef needs an externalRef to move the company to',
      path: ['formerRef'],
    }),
])
export type CompanyRef = z.infer<typeof companyRefSchema>
