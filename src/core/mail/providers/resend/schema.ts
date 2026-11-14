import { z } from 'zod'

// The two answers of POST https://api.resend.com/emails, loose: only the fields read.

/** 200: the message was accepted. */
export const resendSentSchema = z.looseObject({ id: z.string().min(1) })

/**
 * 4xx / 5xx. Resend's error page lists the names (validation_error, rate_limit_exceeded, …) but
 * shows no body, so every field is optional and a body that is not this shape still classifies by
 * its status.
 */
export const resendErrorSchema = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  statusCode: z.number().optional(),
})
