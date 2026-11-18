import type { MiddlewareHandler } from 'hono';
import { AppError } from '@/src/core/errors';
import type { AppEnv } from '../types';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowSeconds: number;
  max: number;
  scope: string;
  key?: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string;
}

function clientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headers.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Best-effort, per-isolate rate limiting. Documented as a first line of defence only:
 * Cloudflare's own rate limiting rules are the durable backstop (see docs/SETUP.md).
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = `${options.scope}:${options.key ? options.key(c) : clientIp(c.req.raw.headers)}`;
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowSeconds * 1000 });
    } else {
      existing.count += 1;
      if (existing.count > options.max) {
        const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
        throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', {
          details: { retryAfterSeconds: retryAfter },
        });
      }
    }
    if (buckets.size > 5000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    return next();
  };
}
