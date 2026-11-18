import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, safeErrorMessage } from '@/src/core/errors';
import { createLogger } from '@/src/core/logger';
import { addMinutes, isoInstant } from '@/src/core/time';
import { exchangeLinkedInCode, fetchLinkedInProfile } from '@/src/adapters/linkedin/linkedin';
import { readLocalOutbox } from '@/src/adapters/services/local';
import type { IntegrationProvider } from '@/src/core/types';
import { fail, notFound, ok } from '../http';
import { parseOrThrow, providerParamSchema, sheetConfigSchema } from '../schemas';
import type { AppEnv } from '../types';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export const integrationRoutes = new Hono<AppEnv>();

integrationRoutes.get('/', async (c) => {
  const services = c.get('services');
  const [integrations, sheets, linkedin, email] = await Promise.all([
    services.db.listIntegrations(),
    services.sheets.describe().catch((error: unknown) => ({
      connected: false,
      sheetLabel: safeErrorMessage(error),
      sheetId: null,
    })),
    services.linkedin
      .status()
      .catch(() => ({ connected: false, label: null, expiresAt: null, needsReauth: true })),
    services.email.describe().catch(() => ({ connected: false, fromEmail: '' })),
  ]);
  return ok(c, {
    servicesMode: services.config.servicesMode,
    googleSheets: {
      ...sheets,
      lastError:
        integrations.find((integration) => integration.provider === 'google_sheets')?.lastError ??
        null,
      configured: Boolean(services.config.google.clientId && services.config.google.clientSecret),
    },
    linkedin: {
      ...linkedin,
      configured: Boolean(
        services.config.linkedin.clientId && services.config.linkedin.clientSecret,
      ),
    },
    email: { ...email, provider: 'resend' },
    ai: { provider: services.ai.id, model: services.ai.model },
  });
});

/** Local-development email outbox (never available in production). */
integrationRoutes.get('/dev/outbox', async (c) => {
  const services = c.get('services');
  if (services.config.servicesMode !== 'local') {
    return fail(c, notFound('Not available'));
  }
  return ok(c, { messages: readLocalOutbox() });
});

integrationRoutes.get('/:provider/authorize', async (c) => {
  const services = c.get('services');
  const provider = parseOrThrow(providerParamSchema, c.req.param('provider'));
  const redirectAfter = c.req.query('redirect') ?? '/settings/?tab=integrations';
  const state = crypto.randomUUID().replace(/-/g, '');
  await services.db.createOAuthState({
    state,
    provider,
    expiresAt: isoInstant(addMinutes(services.clock.now(), 10)),
    redirectAfter,
  });

  const redirectUri = `${services.config.baseUrl}/api/v1/integrations/${provider}/callback`;

  if (provider === 'google_sheets') {
    if (!services.config.google.clientId) {
      return fail(
        c,
        new AppError('CONFIG_ERROR', 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured.'),
      );
    }
    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set('client_id', services.config.google.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SHEETS_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    return ok(c, { url: url.toString() });
  }

  const { linkedInAuthorizeUrl } = await import('@/src/adapters/linkedin/linkedin');
  if (!services.config.linkedin.clientId) {
    return fail(
      c,
      new AppError(
        'CONFIG_ERROR',
        'LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not configured.',
      ),
    );
  }
  return ok(c, { url: linkedInAuthorizeUrl(services.config, state, redirectUri) });
});

integrationRoutes.get('/:provider/callback', async (c) => {
  const services = c.get('services');
  const providerResult = providerParamSchema.safeParse(c.req.param('provider'));
  if (!providerResult.success)
    return c.redirect(
      `${services.config.baseUrl}/settings/?tab=integrations&error=unknown_provider`,
    );
  const provider = providerResult.data;
  const state = c.req.query('state');
  const code = c.req.query('code');
  const oauthError = c.req.query('error');
  const oauthErrorDescription = c.req.query('error_description');
  const log = createLogger(services.db, { actor: 'oauth' });

  const settingsUrl = (params: Record<string, string>): string => {
    const url = new URL('/settings/', services.config.baseUrl);
    url.searchParams.set('tab', 'integrations');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  };

  if (oauthError) {
    await log.warn('oauth.denied', `OAuth denied: ${oauthError}`, {
      provider,
      description: oauthErrorDescription,
    });
    return c.redirect(settingsUrl({ error: oauthError }));
  }
  if (!state) return c.redirect(settingsUrl({ error: 'missing_state' }));
  const storedState = await services.db.consumeOAuthState(state);
  if (!storedState || storedState.provider !== provider) {
    await log.warn('oauth.invalid_state', 'OAuth state missing or expired', { provider });
    return c.redirect(settingsUrl({ error: 'invalid_state' }));
  }
  if (!code) return c.redirect(settingsUrl({ error: 'missing_code' }));

  const redirectUri = `${services.config.baseUrl}/api/v1/integrations/${provider}/callback`;

  try {
    if (provider === 'google_sheets') {
      if (!services.config.google.clientId || !services.config.google.clientSecret) {
        throw new AppError('CONFIG_ERROR', 'Google OAuth client is not configured.');
      }
      const response = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: services.config.google.clientId,
          client_secret: services.config.google.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new AppError(
          'SHEETS_ERROR',
          `Google token exchange failed (HTTP ${response.status}).`,
        );
      }
      const payload = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!payload.access_token)
        throw new AppError('SHEETS_ERROR', 'Google returned no access token.');
      if (!payload.refresh_token) {
        throw new AppError(
          'SHEETS_ERROR',
          'Google did not return a refresh token. Remove the app from your Google account permissions and try again (prompt=consent is required).',
        );
      }
      const existing = await services.db.getIntegration('google_sheets');
      await services.db.upsertIntegration('google_sheets', {
        status: 'connected',
        accountLabel: 'Google Sheets',
        scopes: payload.scope ? payload.scope.split(' ').filter(Boolean) : [SHEETS_SCOPE],
        accessTokenEnc: await services.cipher.encrypt(payload.access_token),
        refreshTokenEnc: await services.cipher.encrypt(payload.refresh_token),
        tokenExpiresAt: isoInstant(new Date(Date.now() + (payload.expires_in ?? 3500) * 1000)),
        metadata: { ...(existing?.metadata ?? {}) },
        lastCheckedAt: isoInstant(services.clock.now()),
        lastError: null,
      });
      await log.info('oauth.google_connected', 'Google Sheets connected');
      return c.redirect(settingsUrl({ connected: 'google_sheets' }));
    }

    const token = await exchangeLinkedInCode(services.config, code, redirectUri);
    const profile = await fetchLinkedInProfile(token.accessToken);
    await services.db.upsertIntegration('linkedin', {
      status: 'connected',
      accountLabel: profile.name,
      scopes: ['openid', 'profile', 'w_member_social'],
      accessTokenEnc: await services.cipher.encrypt(token.accessToken),
      refreshTokenEnc: null,
      tokenExpiresAt: isoInstant(new Date(Date.now() + token.expiresInSeconds * 1000)),
      metadata: {
        authorUrn: `urn:li:person:${profile.sub}`,
        personName: profile.name,
      },
      lastCheckedAt: isoInstant(services.clock.now()),
      lastError: null,
    });
    await log.info('oauth.linkedin_connected', 'LinkedIn connected', { person: profile.name });
    return c.redirect(settingsUrl({ connected: 'linkedin' }));
  } catch (error) {
    await log.error('oauth.callback_failed', safeErrorMessage(error), { provider });
    return c.redirect(
      settingsUrl({ error: encodeURIComponent(safeErrorMessage(error)).slice(0, 200) }),
    );
  }
});

integrationRoutes.post('/google-sheets/config', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(sheetConfigSchema, await c.req.json().catch(() => ({})));
  let sheetId = body.sheetId ?? null;
  if (!sheetId && body.sheetUrl) {
    const match = body.sheetUrl.match(/\/spreadsheets\/d\/([A-Za-z0-9-_]+)/);
    sheetId = match?.[1] ?? null;
    if (!sheetId) {
      return fail(
        c,
        new AppError('VALIDATION_FAILED', 'That does not look like a Google Sheets URL.'),
      );
    }
  }
  const existing = await services.db.getIntegration('google_sheets');
  const integration = await services.db.upsertIntegration('google_sheets', {
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(sheetId ? { sheetId } : {}),
      ...(body.sheetTab ? { sheetTab: body.sheetTab } : {}),
    },
    lastCheckedAt: isoInstant(services.clock.now()),
  });
  await createLogger(services.db, { actor: c.get('actor') }).info(
    'integration.sheet_configured',
    'Sheet configured',
    {
      sheetId: sheetId ?? existing?.metadata?.sheetId ?? null,
    },
  );
  return ok(c, { integration });
});

integrationRoutes.post('/:provider/test', async (c) => {
  const services = c.get('services');
  // resend/gemini are testable too, but are not connectable via OAuth
  const providerResult = providerParamSchema
    .or(z.enum(['resend', 'gemini']))
    .safeParse(c.req.param('provider'));
  if (!providerResult.success) return fail(c, notFound('Unknown provider'));
  const provider = providerResult.data as IntegrationProvider;
  const log = createLogger(services.db, { actor: c.get('actor') });

  try {
    if (provider === 'google_sheets') {
      const snapshot = await services.sheets.readRows();
      await log.info('integration.test.sheets_ok', 'Google Sheets reachable', {
        rows: snapshot.rows.length,
      });
      return ok(c, {
        provider,
        ok: true,
        message: `Read ${snapshot.rows.length} eligible topic row(s) from "${snapshot.sheetLabel}".`,
        issues: snapshot.issues,
      });
    }
    if (provider === 'linkedin') {
      const status = await services.linkedin.status();
      return ok(c, {
        provider,
        ok: status.connected,
        message: status.connected
          ? `Connected as ${status.label ?? 'your profile'}. Token expires ${status.expiresAt ?? 'unknown'}.`
          : 'LinkedIn is not connected (or the token expired).',
        needsReauth: status.needsReauth,
      });
    }
    if (provider === 'resend') {
      const { sendOwnerEmail } = await import('@/src/core/notify');
      const result = await sendOwnerEmail(
        services,
        log,
        {
          subject: 'Resend test email',
          html: '<p>Your Resend integration works. Approval emails will arrive at this address.</p>',
          text: 'Your Resend integration works.',
        },
        { respectEmailSetting: false },
      );
      return ok(c, {
        provider,
        ok: result.sent,
        message: result.sent ? 'Test email sent.' : `Email failed: ${result.error}`,
      });
    }

    const draft = await services.ai.generatePost({
      topic: 'Connectivity test for the content generator',
      contentType: 'insight',
      keyPoints: null,
      targetAudience: null,
      brandVoice: (await services.db.getSettings()).brandVoice,
      writingInstructions: 'Keep it short. This is a connectivity test.',
      hashtagMin: 2,
      hashtagMax: 3,
      maxChars: 900,
      recentHooks: [],
    });
    return ok(c, {
      provider,
      ok: true,
      message: `AI provider "${services.ai.id}" responded using ${services.ai.model}.`,
      sample: draft.hook,
    });
  } catch (error) {
    return ok(c, { provider, ok: false, message: safeErrorMessage(error) });
  }
});

integrationRoutes.delete('/:provider', async (c) => {
  const services = c.get('services');
  const provider = parseOrThrow(providerParamSchema, c.req.param('provider'));
  const integration = await services.db.upsertIntegration(provider, {
    status: 'disconnected',
    accessTokenEnc: null,
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    lastError: null,
    scopes: [],
    accountLabel: null,
  });
  await createLogger(services.db, { actor: c.get('actor') }).warn(
    'integration.disconnected',
    `${provider} disconnected`,
  );
  return ok(c, { integration });
});
