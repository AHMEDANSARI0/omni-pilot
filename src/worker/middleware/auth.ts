import type { MiddlewareHandler } from 'hono';
import { AppError } from '@/src/core/errors';
import type { AppEnv } from '../types';

interface CachedUser {
  email: string | null;
  expiresAt: number;
}

const userCache = new Map<string, CachedUser>();

/**
 * Owner-only authentication for the dashboard API.
 *
 * Order of checks:
 *  1. Explicit local bypass (ALLOW_DEV_BYPASS, never allowed in production).
 *  2. DEV_OWNER_TOKEN header (development only).
 *  3. Supabase Auth access token, validated against Supabase and matched to OWNER_EMAIL.
 */
export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const services = c.get('services');
  const { config } = services;

  if (config.auth.allowDevBypass && config.appEnv !== 'production') {
    c.set('actor', 'local-dev');
    c.set('authMode', 'dev-bypass');
    return next();
  }

  const devToken = c.req.header('x-dev-owner-token');
  if (devToken && config.auth.devOwnerToken && devToken === config.auth.devOwnerToken) {
    c.set('actor', 'dev-token');
    c.set('authMode', 'dev-token');
    return next();
  }

  const header = c.req.header('Authorization') ?? c.req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    throw new AppError('UNAUTHORIZED', 'Sign in to access the dashboard.', {
      details: { hint: 'Send Authorization: Bearer <supabase access token>' },
    });
  }
  const accessToken = header.slice(7).trim();
  if (!accessToken) throw new AppError('UNAUTHORIZED', 'Missing access token.');

  const cached = userCache.get(accessToken);
  let resolvedEmail: string | null = cached && cached.expiresAt > Date.now() ? cached.email : null;
  if (!resolvedEmail) {
    resolvedEmail = await fetchSupabaseEmail(
      config.supabase.url,
      accessToken,
      config.supabase.serviceRoleKey,
    );
    if (!resolvedEmail)
      throw new AppError('UNAUTHORIZED', 'Session is invalid or expired. Sign in again.');
    userCache.set(accessToken, { email: resolvedEmail, expiresAt: Date.now() + 60_000 });
  }
  const email = resolvedEmail;

  if (email.toLowerCase() !== config.ownerEmail.toLowerCase()) {
    throw new AppError('FORBIDDEN', 'This account is not the configured owner.');
  }

  c.set('actor', email);
  c.set('authMode', 'owner');
  return next();
};

async function fetchSupabaseEmail(
  supabaseUrl: string,
  accessToken: string,
  apiKey: string,
): Promise<string | null> {
  if (!supabaseUrl) return null;
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { email?: string | null };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

/** Cron/webhook authentication using a shared secret (constant-time-ish comparison). */
export function requireCronSecret(request: Request, expected: string): void {
  const provided =
    request.headers.get('x-cron-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!expected || provided.length !== expected.length) {
    throw new AppError('UNAUTHORIZED', 'Invalid or missing cron secret.');
  }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (mismatch !== 0) throw new AppError('UNAUTHORIZED', 'Invalid or missing cron secret.');
}
