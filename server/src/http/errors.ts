import type { ApiError, ErrorCode } from '@elsewhere/shared';

const STATUS: Partial<Record<ErrorCode, number>> = {
  bad_request: 400,
  invalid_name: 400,
  message_too_long: 400,
  unauthorized: 401,
  forbidden: 403,
  blocked: 403,
  not_found: 404,
  name_taken: 409,
  rate_limited: 429,
  not_implemented: 501,
  internal: 500,
};

/** Throw from services/routes to produce a typed ApiError response. */
export class ApiFailure extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = STATUS[code] ?? 400,
  ) {
    super(message);
  }
  toBody(): ApiError {
    return { error: { code: this.code, message: this.message } };
  }
}

export const notImplemented = (what: string): ApiFailure => new ApiFailure('not_implemented', `${what} is not implemented yet`);
