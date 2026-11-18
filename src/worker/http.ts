import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, isAppError, safeErrorMessage, toAppError } from '@/src/core/errors';

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** Maps framework/validation errors onto the shared API error envelope. */
export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'ValidationError') {
    const details = (error as Error & { details?: Record<string, unknown> }).details;
    return new AppError('VALIDATION_FAILED', safeErrorMessage(error), { details });
  }
  if (name === 'ZodError' || name === '$ZodError') {
    const issues = (error as unknown as { issues?: Array<{ path: unknown[]; message: string }> })
      .issues;
    return new AppError('CONFIG_ERROR', 'Environment configuration is invalid.', {
      details: { issues: issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    });
  }
  if (name === 'NotFoundError') {
    return new AppError('NOT_FOUND', 'Endpoint not found.');
  }
  return toAppError(error);
}

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200): Response {
  const body: ApiSuccess<T> = { ok: true, data };
  return c.json(body, status);
}

export function created<T>(c: Context, data: T): Response {
  return ok(c, data, 201);
}

export function fail(c: Context, error: unknown): Response {
  const appError = normalizeError(error);
  const body: ApiFailure = {
    ok: false,
    error: {
      code: appError.code,
      message: safeErrorMessage(appError),
      ...(appError.details ? { details: appError.details } : {}),
    },
  };
  if (appError.status >= 500) {
    console.error(`[error] ${appError.code}: ${body.error.message}`);
  }
  return c.json(body, appError.status as ContentfulStatusCode);
}

export function badRequest(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('BAD_REQUEST', message, { details });
}

export function notFound(message = 'Not found'): AppError {
  return new AppError('NOT_FOUND', message);
}

export { isAppError };
