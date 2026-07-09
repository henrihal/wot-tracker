import type { ErrorRequestHandler } from 'express'
import { apiError } from './http.js'

// Express 5 error-handling middleware. Express 5 forwards async rejections
// and synchronous throws from route handlers here, so this is what turns a
// Prisma error or a JSON.parse of a corrupt cache row into the API's JSON
// envelope instead of Express's default HTML 500. Must be registered AFTER
// all routes (error middleware is matched by arity + position).
//
// Honors `err.status` / `err.statusCode` when Express set them (e.g.
// express.json() raises status:400 on malformed JSON, http-errors sets
// statusCode) so client errors aren't mislabeled as 500 and don't trip 5xx
// alerting. Anything without a valid 4xx/5xx status falls back to 500.
export const apiErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('Unhandled error:', err)
  const status = readErrorStatus(err)
  res.status(status).json(
    apiError({
      code: status,
      message: status >= 500 ? 'Internal server error' : 'Bad request',
    })
  )
}

const readErrorStatus = (err: unknown): number => {
  if (typeof err !== 'object' || err === null) return 500
  if (
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 600
  ) {
    return err.status
  }
  if (
    'statusCode' in err &&
    typeof err.statusCode === 'number' &&
    err.statusCode >= 400 &&
    err.statusCode < 600
  ) {
    return err.statusCode
  }
  return 500
}
