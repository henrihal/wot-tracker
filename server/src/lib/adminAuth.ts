import { timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'
import { sendApiError } from './http.js'

// Shared secret for /admin/* endpoints. Read once at module load; an unset/empty
// value disables admin entirely (fail-closed) so an unconfigured server never
// exposes capture/refresh ops.
const ADMIN_TOKEN = process.env['ADMIN_TOKEN'] ?? ''

// Constant-time string compare to avoid leaking the secret length/contents via
// a timing side channel. timingSafeEqual throws on mismatched Buffer lengths,
// so guard that case with a cheap length check first (the lengths themselves
// are not secret).
const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

// Guards every /admin/* route behind an X-Admin-Token header checked against
// ADMIN_TOKEN. Fail-closed: if ADMIN_TOKEN is not configured, every admin route
// returns 503 (admin disabled) regardless of the header. A missing or
// mismatched header returns 401. On success, falls through to the route.
export const adminAuth: RequestHandler = (req, res, next) => {
  if (!ADMIN_TOKEN) {
    sendApiError(res, 503, {
      code: 503,
      message: 'Admin endpoints disabled: ADMIN_TOKEN not configured.',
    })
    return
  }

  const token = req.get('x-admin-token')
  if (!token || !safeEqual(token, ADMIN_TOKEN)) {
    sendApiError(res, 401, {
      code: 401,
      message: 'Unauthorized: invalid or missing X-Admin-Token header.',
    })
    return
  }

  next()
}
