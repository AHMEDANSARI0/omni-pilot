import { Hono } from 'hono';
import { AppError, safeErrorMessage } from '@/src/core/errors';
import { createLogger } from '@/src/core/logger';
import { describeSchedule } from '@/src/core/scheduler';
import { fail, ok } from '../http';
import { parseOrThrow, settingsPatchSchema } from '../schemas';
import type { AppEnv } from '../types';

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get('/', async (c) => {
  const services = c.get('services');
  const settings = await services.db.getSettings();
  return ok(c, {
    settings,
    ai: { provider: services.ai.id, model: services.ai.model },
    servicesMode: services.config.servicesMode,
    ownerEmail: services.config.ownerEmail,
    baseUrl: services.config.baseUrl,
  });
});

settingsRoutes.patch('/', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(settingsPatchSchema, await c.req.json().catch(() => ({})));
  const current = await services.db.getSettings();
  const merged = { ...current, ...body };

  if (merged.hashtagMin > merged.hashtagMax) {
    return fail(c, new AppError('VALIDATION_FAILED', 'hashtagMin must be <= hashtagMax.'));
  }
  if (merged.maxPostChars < 300 || merged.maxPostChars > 3000) {
    return fail(c, new AppError('VALIDATION_FAILED', 'maxPostChars must be between 300 and 3000.'));
  }

  const updated = await services.db.updateSettings(body);
  await createLogger(services.db, { actor: c.get('actor') }).info(
    'settings.updated',
    'Settings updated',
    {
      fields: Object.keys(body),
    },
  );
  return ok(c, { settings: updated });
});

settingsRoutes.get('/schedule', async (c) => {
  const services = c.get('services');
  const overview = await describeSchedule(services);
  return ok(c, overview);
});

settingsRoutes.get('/health', async (c) => {
  const services = c.get('services');
  const [sheets, linkedin, email, integrations, state] = await Promise.all([
    services.sheets.describe().catch((error: unknown) => ({
      connected: false,
      sheetLabel: safeErrorMessage(error),
      sheetId: null,
    })),
    services.linkedin
      .status()
      .catch(() => ({ connected: false, label: null, expiresAt: null, needsReauth: false })),
    services.email.describe().catch(() => ({ connected: false, fromEmail: '' })),
    services.db.listIntegrations().catch(() => []),
    services.db.getSchedulerState().catch(() => null),
  ]);
  return ok(c, {
    appEnv: services.config.appEnv,
    servicesMode: services.config.servicesMode,
    aiProvider: services.ai.id,
    aiModel: services.ai.model,
    sheets,
    linkedin,
    email,
    integrations: integrations.map((integration) => ({
      provider: integration.provider,
      status: integration.status,
      accountLabel: integration.accountLabel,
      lastCheckedAt: integration.lastCheckedAt,
      lastError: integration.lastError,
    })),
    scheduler: state,
  });
});
