import { Hono } from 'hono';
import { handleWebhook, whatsappStatus } from '@/src/core/whatsapp';
import { createLogger } from '@/src/core/logger';
import { safeErrorMessage } from '@/src/core/errors';
import { ok } from '../http';
import type { AppEnv } from '../types';

/**
 * Meta webhook + owner-only status endpoints. The webhook is public (Meta calls it) and is
 * authenticated by the `X-Hub-Signature-256` HMAC plus the owner-number allowlist.
 */
/** Mounted at /api/v1/integrations/whatsapp (public: Meta calls it). */
export const whatsappWebhookRoutes = new Hono<AppEnv>();

whatsappWebhookRoutes.get('/webhook', (c) => {
  const services = c.get('services');
  const expected = services.config.whatsapp.verifyToken;
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge') ?? '';
  if (mode !== 'subscribe' || !expected || token !== expected) {
    return c.text('Forbidden', 403);
  }
  return c.text(challenge, 200);
});

whatsappWebhookRoutes.post('/webhook', async (c) => {
  const services = c.get('services');
  const rawBody = await c.req.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    payload = null;
  }

  const result = await handleWebhook(services, {
    rawBody,
    signature: c.req.header('x-hub-signature-256') ?? null,
    payload,
  });

  if (!result.ok) {
    return c.json({ ok: false, error: result.reason ?? 'rejected' }, result.status as 401 | 503);
  }
  return c.json({ ok: true, processed: result.processed });
});

/** Owner-only routes, mounted at /api/v1/whatsapp behind auth. */
export const whatsappRoutes = new Hono<AppEnv>();

whatsappRoutes.get('/status', async (c) => {
  const services = c.get('services');
  return ok(c, {
    ...whatsappStatus(services),
    webhookUrl: `${services.config.baseUrl}/api/v1/integrations/whatsapp/webhook`,
    verifyTokenSet: Boolean(services.config.whatsapp.verifyToken),
    appSecretSet: Boolean(services.config.whatsapp.appSecret),
  });
});

/** Sends a one-off "channel is live" message to the owner number. */
whatsappRoutes.post('/test', async (c) => {
  const services = c.get('services');
  const log = createLogger(services.db, { actor: c.get('actor') });
  const owner = services.config.whatsapp.ownerNumber;
  if (!owner) {
    return ok(c, { ok: false, message: 'WHATSAPP_OWNER_NUMBER is not configured.' });
  }
  try {
    await services.whatsapp.sendText(
      owner,
      'PostPilot is connected ✅\nApproval emails will now include a one-tap WhatsApp link.',
    );
    await log.info('whatsapp.test_sent', 'WhatsApp test message sent');
    return ok(c, { ok: true, message: 'Test message sent to the owner number.' });
  } catch (error) {
    await log.warn('whatsapp.test_failed', 'WhatsApp test message failed', {
      error: safeErrorMessage(error),
    });
    return ok(c, { ok: false, message: safeErrorMessage(error) });
  }
});
