export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_TOPIC'
  | 'GONE'
  | 'RATE_LIMITED'
  | 'CONFIG_ERROR'
  | 'INTEGRATION_ERROR'
  | 'AI_ERROR'
  | 'SHEETS_ERROR'
  | 'EMAIL_ERROR'
  | 'LINKEDIN_ERROR'
  | 'WHATSAPP_ERROR'
  | 'DATABASE_ERROR'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  // A near-duplicate is a decision, not a bug: 409 so a client can offer "add anyway".
  DUPLICATE_TOPIC: 409,
  GONE: 410,
  RATE_LIMITED: 429,
  CONFIG_ERROR: 500,
  INTEGRATION_ERROR: 502,
  AI_ERROR: 502,
  SHEETS_ERROR: 502,
  EMAIL_ERROR: 502,
  LINKEDIN_ERROR: 502,
  WHATSAPP_ERROR: 502,
  DATABASE_ERROR: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryable = options.retryable ?? isDefaultRetryable(code);
  }
}

function isDefaultRetryable(code: ErrorCode): boolean {
  return ['AI_ERROR', 'EMAIL_ERROR', 'SHEETS_ERROR', 'LINKEDIN_ERROR', 'DATABASE_ERROR'].includes(
    code,
  );
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return new AppError('INTERNAL', message, { cause: error });
}

/** Redacts common secret-shaped strings so logs and API errors never leak credentials. */
export function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b(sk|re|AIza|ya29|1\/\/)[A-Za-z0-9._~+/=-]{8,}/g, '[redacted]')
    .replace(
      /(access_token|refresh_token|api_key|apikey|client_secret)=([^&\s]+)/gi,
      '$1=[redacted]',
    );
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redact(error.message).slice(0, 1000);
  return redact(String(error)).slice(0, 1000);
}
