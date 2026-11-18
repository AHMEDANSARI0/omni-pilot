import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, safeErrorMessage } from '@/src/core/errors';
import { rateLimit } from '../middleware/rate-limit';
import { fail, ok } from '../http';
import { parseOrThrow } from '../schemas';
import type { AppEnv } from '../types';

/**
 * Thin Supabase Auth proxy so the static dashboard never needs Supabase keys baked into
 * the bundle. Only the configured owner email can obtain a usable session.
 */
export const authRoutes = new Hono<AppEnv>();

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(6).max(200),
  })
  .strict();

const refreshSchema = z.object({ refreshToken: z.string().min(10) }).strict();

authRoutes.get('/mode', async (c) => {
  const services = c.get('services');
  const devBypass = services.config.auth.allowDevBypass && services.config.appEnv !== 'production';
  const configured = Boolean(services.config.supabase.anonKey && services.config.supabase.url);
  return ok(c, {
    requiresAuth: !devBypass,
    devBypass,
    supabaseConfigured: configured,
    servicesMode: services.config.servicesMode,
    ownerEmailHint: maskEmail(services.config.ownerEmail),
  });
});

authRoutes.post('/login', rateLimit({ scope: 'login', windowSeconds: 60, max: 10 }), async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(loginSchema, await c.req.json().catch(() => ({})));
  if (!services.config.supabase.anonKey) {
    return fail(
      c,
      new AppError('CONFIG_ERROR', 'Supabase Auth is not configured (SUPABASE_ANON_KEY missing).'),
    );
  }
  if (body.email.toLowerCase() !== services.config.ownerEmail.toLowerCase()) {
    return fail(c, new AppError('FORBIDDEN', 'This account is not the configured owner.'));
  }
  try {
    const session = await supabaseTokenRequest(
      services.config.supabase.url,
      services.config.supabase.anonKey,
      {
        email: body.email,
        password: body.password,
        grant_type: 'password',
      },
    );
    return ok(c, session);
  } catch (error) {
    return fail(c, new AppError('UNAUTHORIZED', safeErrorMessage(error)));
  }
});

authRoutes.post(
  '/refresh',
  rateLimit({ scope: 'refresh', windowSeconds: 60, max: 30 }),
  async (c) => {
    const services = c.get('services');
    const body = parseOrThrow(refreshSchema, await c.req.json().catch(() => ({})));
    if (!services.config.supabase.anonKey) {
      return fail(c, new AppError('CONFIG_ERROR', 'Supabase Auth is not configured.'));
    }
    try {
      const session = await supabaseTokenRequest(
        services.config.supabase.url,
        services.config.supabase.anonKey,
        {
          refresh_token: body.refreshToken,
          grant_type: 'refresh_token',
        },
      );
      return ok(c, session);
    } catch (error) {
      return fail(c, new AppError('UNAUTHORIZED', safeErrorMessage(error)));
    }
  },
);

async function supabaseTokenRequest(
  supabaseUrl: string,
  anonKey: string,
  payload: Record<string, string>,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string; email: string }> {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=${payload.grant_type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message =
      typeof parsed.error_description === 'string'
        ? parsed.error_description
        : typeof parsed.msg === 'string'
          ? parsed.msg
          : `Supabase auth failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  const refreshToken =
    typeof parsed.refresh_token === 'string' ? parsed.refresh_token : (payload.refresh_token ?? '');
  const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
  const user = parsed.user as { email?: string } | undefined;
  if (!accessToken) throw new Error('Supabase returned no access token');
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    email: user?.email ?? payload.email ?? '',
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - 2, 2))}@${domain}`;
}
