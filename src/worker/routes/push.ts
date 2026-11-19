import { Hono } from 'hono';
import { AppError } from '@/src/core/errors';
import { sendTestPush } from '@/src/core/push-send';
import { parseSubscription } from '@/src/core/push';
import { fail, ok } from '../http';
import { requireOwner } from '../middleware/auth';
import type { AppEnv } from '../types';

/**
 * Web push subscriptions.
 *
 * These live under the owner's session, not the API-key surface: only the person holding the dashboard
 * can decide that this browser should buzz. `publicKey` is public by design (it identifies the app to the
 * push service), so it is served without auth so the page can render before login settles.
 */
export const pushRoutes = new Hono<AppEnv>();

pushRoutes.get('/public-key', async (c) => {
  const services = c.get('services');
  const key = services.config.push.publicKey;
  return ok(c, {
    publicKey: key || null,
    // Says plainly whether push can work at all, so the UI does not offer a button that cannot succeed.
    configured: Boolean(key && services.config.push.privateKey),
  });
});

pushRoutes.post('/subscribe', async (c) => {
  const services = c.get('services');
  const parsed = parseSubscription(await c.req.json().catch(() => null));
  if (!parsed) {
    return fail(
      c,
      new AppError('VALIDATION_FAILED', 'That is not a usable push subscription.', {
        details: { hint: 'Expected { endpoint, keys: { p256dh, auth } } from PushManager.subscribe().' },
      }),
    );
  }
  const subscription = await services.db.savePushSubscription(parsed);
  return ok(c, { id: subscription.id, endpoint: subscription.endpoint });
});

pushRoutes.post('/unsubscribe', async (c) => {
  const services = c.get('services');
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) return fail(c, new AppError('VALIDATION_FAILED', 'An endpoint is required.'));
  await services.db.deletePushSubscription(endpoint);
  return ok(c, { removed: true });
});

pushRoutes.post('/test', requireOwner, async (c) => {
  const services = c.get('services');
  const result = await sendTestPush(services);
  if (!result.configured) {
    return fail(
      c,
      new AppError('CONFIG_ERROR', 'Push is not configured (set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY).'),
    );
  }
  return ok(c, result);
});

pushRoutes.get('/devices', requireOwner, async (c) => {
  const services = c.get('services');
  const subscriptions = await services.db.listPushSubscriptions();
  return ok(c, {
    devices: subscriptions.map((subscription) => ({
      id: subscription.id,
      endpointHost: new URL(subscription.endpoint).host,
      userAgent: subscription.userAgent,
      failureCount: subscription.failureCount,
      lastSuccessAt: subscription.lastSuccessAt,
      lastError: subscription.lastError,
      createdAt: subscription.createdAt,
    })),
  });
});
