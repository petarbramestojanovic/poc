import { z } from 'zod'

// Request-schema pieces more than one route uses.

/** A valid IANA zone, checked the way the runtime will use it. */
export const ianaTimezone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: value })
      return true
    } catch {
      return false
    }
  },
  { error: 'not an IANA timezone' },
)
