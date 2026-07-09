import type { ErrorRequestHandler } from 'express'
import { apiError } from './http.js'

// Express 5 error handler: turns async rejections / sync throws (Prisma, a
// corrupt cache JSON.parse) into the API's JSON envelope instead of HTML 500.
// Honors err.status / err.statusCode so client errors aren't mislabeled 5xx;
// else 500. Register after all routes (matched by arity + position).
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
