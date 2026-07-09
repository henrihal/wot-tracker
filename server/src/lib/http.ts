import type { Response } from 'express'

// Options for building an API error envelope. `field` and `value` are present
// on validation errors and omitted on upstream-style errors; they are declared
// without `| undefined` so that under `exactOptionalPropertyTypes` callers must
// omit the key (not pass `undefined`) when the value is absent.
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

// Build the error envelope body, inserting `field`/`value` only when supplied
// so they are omitted (not set to undefined) under exactOptionalPropertyTypes.
export const apiError = (opts: ApiErrorOptions): ApiErrorResult => {
  const error: ApiErrorResult['error'] = {
    code: opts.code,
    message: opts.message,
  }
  if (opts.field !== undefined) error.field = opts.field
  if (opts.value !== undefined) error.value = opts.value
  return { status: 'error', error }
}

// Send an error envelope with an explicit HTTP status (decoupled from the
// envelope code, matching current behavior: validation = HTTP 400 / code 402).
export const sendApiError = (
  res: Response,
  httpStatus: number,
  opts: ApiErrorOptions
): void => {
  res.status(httpStatus).json(apiError(opts))
}

// Structural constraint for any API result, whether a discriminated union
// (StatsDeltaResult/StatsSummaryResult — error required on the error branch)
// or a loose interface (WargamingSearchResponse/WargamingInfoResponse —
// error optional). The ok-shape carries its own fields (range, deltas,
// metrics, ranges, data, ...) which sendResult forwards untouched via R.
export type TaggedApiResult = {
  status: 'ok' | 'error'
  error?: { code: number; message: string }
}

// Send any API result. On 'ok' -> res.json(result). On 'error' -> promote the
// envelope code to the HTTP status ONLY for codes that are genuinely
// HTTP-status-worthy: upstream/server errors (5xx) and the
// INSUFFICIENT_HISTORY 422. Validation errors carry envelope code 402 but must
// stay HTTP 400 (and config/auth-style 401/403 likewise), so they fall through
// to the 400 default.
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
