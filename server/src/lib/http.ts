import type { Response } from 'express'

// `field`/`value` are present on validation errors and omitted on upstream
// errors; declared without `| undefined` so under exactOptionalPropertyTypes
// callers must omit the key (not pass undefined) when absent.
export type ApiErrorOptions = {
  code: number
  message: string
  field?: string
  value?: string | number
}

export type ApiErrorResult = {
  status: 'error'
  error: {
    code: number
    message: string
    field?: string
    value?: string | number
  }
}

// Build the error envelope, inserting field/value only when supplied.
export const apiError = (opts: ApiErrorOptions): ApiErrorResult => {
  const error: ApiErrorResult['error'] = {
    code: opts.code,
    message: opts.message,
  }
  if (opts.field !== undefined) error.field = opts.field
  if (opts.value !== undefined) error.value = opts.value
  return { status: 'error', error }
}

// Send an error envelope with an explicit HTTP status, decoupled from the
// envelope code (validation = HTTP 400 / code 402).
export const sendApiError = (
  res: Response,
  httpStatus: number,
  opts: ApiErrorOptions
): void => {
  res.status(httpStatus).json(apiError(opts))
}

// Structural shape for any API result: a discriminated union (error required on
// the error branch) or a loose interface (error optional). The ok-shape carries
// its own fields, forwarded untouched via R.
export type TaggedApiResult = {
  status: 'ok' | 'error'
  error?: { code: number; message: string }
}

// Send any API result. On 'ok' -> res.json(result). On 'error' -> promote the
// envelope code to the HTTP status only for 5xx and INSUFFICIENT_HISTORY (422);
// validation (402) and auth (401/403) stay HTTP 400 so client codes never leak
// into HTTP status.
export const sendResult = <R extends TaggedApiResult>(
  res: Response,
  result: R
): void => {
  if (result.status === 'ok') {
    res.json(result)
    return
  }
  const code = result.error?.code
  const httpStatus =
    code !== undefined && (code === 422 || (code >= 500 && code < 600))
      ? code
      : 400
  res.status(httpStatus).json(result)
}
