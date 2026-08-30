import { timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'
import { sendApiError } from './http.js'

// Shared secret for /admin/*; unset/empty disables admin entirely (fail-closed).
const ADMIN_TOKEN = process.env['ADMIN_TOKEN'] ?? ''

// Constant-time compare; length-check first since timingSafeEqual throws on
// length mismatch (lengths themselves aren't secret).
const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

// Guard /admin/* via X-Admin-Token: 503 if unset, 401 if missing/mismatched.
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
