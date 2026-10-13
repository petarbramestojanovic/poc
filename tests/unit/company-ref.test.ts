import { describe, expect, it } from 'vitest'
import { companyRefSchema } from '../../src/modules/companies/input.ts'

// How a setup names its company. The former reference is only ever a way to find a company the
// same system once keyed differently, so it is refused without the reference to move it to.

const ref = { system: 'salesforce', id: '001Aa00000KlMnOpQR' }
const formerRef = { system: 'salesforce', id: 'rauch_gmbh' }

describe('a company reference', () => {
  it('may carry the reference its system used before', () => {
    expect(companyRefSchema.parse({ name: 'Rauch GmbH', externalRef: ref, formerRef })).toEqual({
      name: 'Rauch GmbH',
      externalRef: ref,
      formerRef,
    })
  })

  it('refuses a former reference with nothing to move the company to', () => {
    const parsed = companyRefSchema.safeParse({ name: 'Rauch GmbH', formerRef })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.some((issue) => issue.path.includes('formerRef'))).toBe(true)
  })
})
