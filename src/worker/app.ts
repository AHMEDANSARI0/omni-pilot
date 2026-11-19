import { Hono } from 'hono';
import { createServices as defaultCreateServices } from '@/src/server/services';
import { safeErrorMessage } from '@/src/core/errors';
import { fail, ok } from './http';
import { requireOwner } from './middleware/auth';
import { rateLimit } from './middleware/rate-limit';
import { contentRoutes } from './routes/content';
import { calendarRoutes } from './routes/calendar';
import { omniAdminRoutes, omniApiRoutes } from './routes/omni';
import { pushRoutes } from './routes/push';
import { settingsRoutes } from './routes/settings';
import { approvalRoutes, publicApprovalRoutes } from './routes/approvals';
import { publishingRoutes } from './routes/publishing';
import { integrationRoutes } from './routes/integrations';
import { whatsappRoutes, whatsappWebhookRoutes } from './routes/whatsapp';
import { logRoutes } from './routes/logs';
import { scheduleRoutes } from './routes/schedule';
import { overviewRoutes } from './routes/overview';
import { authRoutes } from './routes/auth';
import type { Services } from '@/src/core/services';
import type { AppEnv } from './types';

export interface AppOptions {
  /** Test seam: replace the composition root (defaults to the real adapters). */
  serviceFactory?: (env: Record<string, string | undefined>) => Promise<Services>;
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const buildServices = options.serviceFactory ?? defaultCreateServices;
  const app = new Hono<AppEnv>();

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // Every API request gets a fully wired service container built from env.
  app.use('/api/v1/*', async (c, next) => {
    const services = await buildServices(c.env);
    c.set('services', services);
    const limiter = rateLimit({
      scope: 'api',
      windowSeconds: services.config.rateLimit.windowSeconds,
      max: services.config.rateLimit.maxRequests,
    });
    return limiter(c, next);
  });

  app.get('/api/v1/health', async (c) => {
    const services = c.get('services');
    const settings = await services.db.getSettings().catch((error: unknown) => ({
      error: safeErrorMessage(error),
    }));
    return ok(c, {
      status: 'ok',
      time: services.clock.now().toISOString(),
      appEnv: services.config.appEnv,
      servicesMode: services.config.servicesMode,
      aiProvider: services.ai.id,
      aiModel: services.ai.model,
      database: 'error' in settings ? { ok: false, error: settings.error } : { ok: true },
    });
  });

  // Public, token-protected approval endpoints (used from the email link).
  app.route('/api/v1/public/approvals', publicApprovalRoutes);
  // Public auth proxy for the static dashboard (owner email only, rate limited).
  app.route('/api/v1/auth', authRoutes);
  // Public Meta webhook (HMAC verified, owner-number allowlisted) + owner status routes.
  app.route('/api/v1/integrations/whatsapp', whatsappWebhookRoutes);

  const ownerApi = new Hono<AppEnv>();
  ownerApi.use('*', requireOwner);
  ownerApi.route('/overview', overviewRoutes);
  ownerApi.route('/content', contentRoutes);
  ownerApi.route('/schedule', scheduleRoutes);
  ownerApi.route('/approvals', approvalRoutes);
  ownerApi.route('/publishing', publishingRoutes);
  ownerApi.route('/integrations', integrationRoutes);
  ownerApi.route('/whatsapp', whatsappRoutes);
  ownerApi.route('/settings', settingsRoutes);
  // Key + webhook management is owner-only: a leaked read key must not be able to mint more keys.
  // Key + webhook management is owner-only: a leaked read key must not be able to mint more keys.
  ownerApi.route('/calendar', calendarRoutes);
  ownerApi.route('/omni/admin', omniAdminRoutes);
  ownerApi.route('/logs', logRoutes);

  app.route('/api/v1', ownerApi);

  // OmniFlow: a machine API, authenticated by an `opk_` key + scope (never a dashboard session), so it
  // is mounted on the app and not under ownerApi.
  app.route('/api/v1/omni', omniApiRoutes);
  // Web push: the public key is public; subscribe/unsubscribe are the browser's own calls.
  app.route('/api/v1/push', pushRoutes);

  app.notFound((c) => {
    if (new URL(c.req.url).pathname.startsWith('/api/')) {
      return fail(c, Object.assign(new Error('Endpoint not found'), { name: 'NotFoundError' }));
    }
    return c.text('Not found', 404);
  });

  app.onError((error, c) => fail(c, error));

  return app;
}
