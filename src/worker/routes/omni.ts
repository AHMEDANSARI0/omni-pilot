import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '@/src/core/errors';
import { generateDailyPost } from '@/src/core/generation';
import {
  API_KEY_PREFIX,
  WEBHOOK_EVENTS,
  emitWebhookEvent,
  hashApiKey,
  mintApiKey,
  newWebhookSecret,
  isWebhookEvent,
  wantsEvent,
} from '@/src/core/omni';
import { webhookDispatcherFor } from '@/src/core/omni-dispatch';
import { publishPost } from '@/src/core/publishing';
import { decideApproval } from '@/src/core/approval';
import { isoInstant } from '@/src/core/time';
import { created, fail, notFound, ok } from '../http';
import { requireApiKey, requireScope } from '../middleware/api-key';
import { parseOrThrow } from '../schemas';
import type { AppEnv } from '../types';

/**
 * OmniFlow: the machine-facing API, plus the owner-facing management routes for its keys and webhooks.
 *
 * Two routers, one file:
 *   `omniApiRoutes`    - `/api/v1/omni/*`, authenticated with an `opk_` key and a scope per route
 *   `omniAdminRoutes`  - `/api/v1/omni/admin/*`, the owner's session, mounted under the dashboard API
 *
 * The machine routes are intentionally small and boring: read the state, draft from a topic, approve,
 * publish. Anything that needs a human decision stays in the dashboard.
 */

export const omniApiRoutes = new Hono<AppEnv>();

const idSchema = z.string().uuid();

/* ------------------------------------------------------------------ read */

omniApiRoutes.get('/me', requireApiKey, async (c) => {
  const key = c.get('apiKey')!;
  const settings = await c.get('services').db.getSettings();
  return ok(c, {
    apiKeyId: key.apiKeyId,
    scopes: key.scopes,
    timezone: settings.ownerTimezone,
    publishTimes: settings.publishTimes.length > 0 ? settings.publishTimes : [settings.publishTime],
  });
});

omniApiRoutes.get('/posts', requireApiKey, requireScope('read'), async (c) => {
  const services = c.get('services');
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
  const status = c.req.query('status');
  const posts = await services.db.listPosts({
    limit,
    from: c.req.query('from'),
    to: c.req.query('to'),
    statuses: status ? (status.split(',').filter(Boolean) as never) : undefined,
  });
  return ok(c, {
    posts: posts.map((post) => ({
      id: post.id,
      runDate: post.runDate,
      slotIndex: post.slotIndex,
      status: post.status,
      hook: post.hook,
      charCount: post.charCount,
      hashtags: post.hashtags,
      publishedUrl: post.publishedUrl,
      publishedAt: post.publishedAt,
    })),
  });
});

omniApiRoutes.get('/posts/:id', requireApiKey, requireScope('read'), async (c) => {
  const services = c.get('services');
  const id = idSchema.safeParse(c.req.param('id'));
  if (!id.success) throw notFound('Post not found');
  const post = await services.db.getPost(id.data);
  if (!post) throw notFound('Post not found');
  const variants = await services.db.listVariants(post.id);
  return ok(c, {
    post,
    variants: variants.map((variant) => ({
      id: variant.id,
      variantIndex: variant.variantIndex,
      angle: variant.angle,
      selected: variant.selected,
    })),
  });
});

omniApiRoutes.get('/topics', requireApiKey, requireScope('read'), async (c) => {
  const services = c.get('services');
  const topics = await services.db.listTopics({
    limit: Math.min(Number(c.req.query('limit') ?? 50) || 50, 200),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });
  return ok(c, { topics });
});

/* ----------------------------------------------------------------- write */

const draftSchema = z
  .object({
    runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    slotIndex: z.number().int().min(0).max(4).optional(),
  })
  .strict();

omniApiRoutes.post('/drafts', requireApiKey, requireScope('write'), async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(draftSchema, await c.req.json().catch(() => ({})));
  const result = await generateDailyPost(services, {
    runDate: body.runDate,
    slotIndex: body.slotIndex ?? 0,
    trigger: 'omni-api',
  });
  if (result.status === 'failed') {
    return fail(c, new AppError('AI_ERROR', `${result.stage}: ${result.error}`));
  }
  const status = result.status === 'generated' ? 201 : 200;
  const post = result.status === 'duplicate' ? result.post : result.status === 'generated' ? result.post : null;
  if (result.status === 'generated') {
    const dispatcher = webhookDispatcherFor(services);
    await emitWebhookEvent(dispatcher, {
      event: 'post.generated',
      eventId: `${result.post.id}:post.generated`,
      data: { postId: result.post.id, runDate: result.post.runDate, slotIndex: result.post.slotIndex },
      baseUrl: services.config.baseUrl,
      now: services.clock.now(),
    }).catch(() => 0);
  }
  return ok(
    c,
    {
      status: result.status,
      post,
      reason: 'reason' in result ? result.reason : null,
    },
    status,
  );
});

const approveSchema = z.object({ note: z.string().max(500).optional() }).strict();

omniApiRoutes.post('/posts/:id/approve', requireApiKey, requireScope('write'), async (c) => {
  const services = c.get('services');
  const id = idSchema.safeParse(c.req.param('id'));
  if (!id.success) throw notFound('Post not found');
  parseOrThrow(approveSchema, await c.req.json().catch(() => ({})));
  const post = await services.db.getPost(id.data);
  if (!post) throw notFound('Post not found');

  // Same code path as the email link and the dashboard: single-use approval, one publish job.
  const result = await decideApproval(services, {
    action: 'approve',
    actor: 'omni-api',
    postId: post.id,
  });
  const dispatcher = webhookDispatcherFor(services);
  await emitWebhookEvent(dispatcher, {
    event: 'post.approved',
    eventId: `${post.id}:post.approved`,
    data: { postId: post.id, runDate: post.runDate },
    baseUrl: services.config.baseUrl,
    now: services.clock.now(),
  }).catch(() => 0);

  return ok(c, {
    approved: true,
    postId: post.id,
    status: result.post.status,
    publish: result.publish,
  });
});

omniApiRoutes.post('/posts/:id/publish', requireApiKey, requireScope('publish'), async (c) => {
  const services = c.get('services');
  const id = idSchema.safeParse(c.req.param('id'));
  if (!id.success) throw notFound('Post not found');
  const outcome = await publishPost(services, id.data, { actor: 'omni-api' });
  const status = outcome.status === 'published' ? 200 : 202;
  return ok(c, outcome, status);
});

/* --------------------------------------------------- owner: keys + hooks */

export const omniAdminRoutes = new Hono<AppEnv>();

const createKeySchema = z
  .object({
    name: z.string().min(1).max(80),
    scopes: z.array(z.enum(['read', 'write', 'publish'])).min(1).max(3),
  })
  .strict();

omniAdminRoutes.get('/keys', async (c) => {
  const services = c.get('services');
  const keys = await services.db.listApiKeys();
  // The hash is never returned; the prefix is enough for the owner to tell keys apart.
  return ok(c, {
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
      createdAt: key.createdAt,
    })),
  });
});

omniAdminRoutes.post('/keys', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(createKeySchema, await c.req.json().catch(() => ({})));
  const minted = mintApiKey();
  const record = await services.db.createApiKey({
    name: body.name,
    keyHash: minted.keyHash,
    keyPrefix: minted.keyPrefix,
    scopes: body.scopes,
  });
  // The only time the plaintext key exists in a response. It is not recoverable afterwards.
  return created(c, {
    id: record.id,
    name: record.name,
    key: minted.key,
    keyPrefix: record.keyPrefix,
    scopes: record.scopes,
    warning: 'Copy this key now - it is hashed on the server and cannot be shown again.',
  });
});

omniAdminRoutes.delete('/keys/:id', async (c) => {
  const services = c.get('services');
  const id = idSchema.safeParse(c.req.param('id'));
  if (!id.success) throw notFound('API key not found');
  const revoked = await services.db.revokeApiKey(id.data, isoInstant(services.clock.now()));
  return ok(c, { id: revoked.id, revokedAt: revoked.revokedAt });
});

const endpointSchema = z
  .object({
    name: z.string().min(1).max(80),
    url: z.string().url(),
    events: z.array(z.string()).min(1),
  })
  .strict();

omniAdminRoutes.get('/webhooks', async (c) => {
  const services = c.get('services');
  const endpoints = await services.db.listWebhookEndpoints();
  const deliveries = await services.db.listWebhookDeliveries({ limit: 20 });
  return ok(c, {
    events: WEBHOOK_EVENTS,
    endpoints: endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      url: endpoint.url,
      events: endpoint.events,
      active: endpoint.active,
      failureCount: endpoint.failureCount,
      lastSuccessAt: endpoint.lastSuccessAt,
      lastFailureAt: endpoint.lastFailureAt,
      lastError: endpoint.lastError,
      // The signing secret is not returned; rotate to see a new one once.
      secretPrefix: endpoint.secret.slice(0, 10),
    })),
    recentDeliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      event: delivery.event,
      status: delivery.status,
      attempts: delivery.attempts,
      responseStatus: delivery.responseStatus,
      nextAttemptAt: delivery.nextAttemptAt,
      createdAt: delivery.createdAt,
    })),
  });
});

omniAdminRoutes.post('/webhooks', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(endpointSchema, await c.req.json().catch(() => ({})));
  // `wantsEvent` asks "does this subscription match that event", which is always true for a literal
  // match - the allow-list check has to be membership in WEBHOOK_EVENTS, not a match against itself.
  const unknown = body.events.filter((event) => event !== '*' && !isWebhookEvent(event));
  if (unknown.length > 0) {
    return fail(
      c,
      new AppError('VALIDATION_FAILED', `Unknown event(s): ${unknown.join(', ')}`, {
        details: { allowed: [...WEBHOOK_EVENTS, '*'] },
      }),
    );
  }
  const secret = newWebhookSecret();
  const endpoint = await services.db.createWebhookEndpoint({
    name: body.name,
    url: body.url,
    secret,
    events: body.events,
  });
  return created(c, {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    events: endpoint.events,
    // Shown once: the receiver needs it to verify the first signature.
    secret,
    hint: 'Verify the X-PostPilot-Signature header as sha256=HMAC(secret, "<timestamp>.<body>").',
  });
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    url: z.string().url().optional(),
    events: z.array(z.string()).min(1).optional(),
    active: z.boolean().optional(),
    rotateSecret: z.boolean().optional(),
  })
  .strict();

omniAdminRoutes.patch('/webhooks/:id', async (c) => {
  const services = c.get('services');
  const id = idSchema.safeParse(c.req.param('id'));
  if (!id.success) throw notFound('Webhook not found');
  const body = parseOrThrow(patchSchema, await c.req.json().catch(() => ({})));
  const secret = body.rotateSecret ? newWebhookSecret() : undefined;
  const endpoint = await services.db.updateWebhookEndpoint(id.data, {
    name: body.name,
    url: body.url,
    events: body.events,
    active: body.active,
    ...(secret ? { secret } : {}),
  });
  return ok(c, {
    id: endpoint.id,
    active: endpoint.active,
    events: endpoint.events,
    ...(secret ? { secret } : {}),
  });
});

omniAdminRoutes.delete('/webhooks/:id', async (c) => {
  const services = c.get('services');
  const id = idSchema.safeParse(c.req.param('id'));
  if (!id.success) throw notFound('Webhook not found');
  await services.db.deleteWebhookEndpoint(id.data);
  return ok(c, { deleted: true });
});

omniAdminRoutes.post('/webhooks/:id/test', async (c) => {
  const services = c.get('services');
  const id = idSchema.safeParse(c.req.param('id'));
  if (!id.success) throw notFound('Webhook not found');
  const endpoints = await services.db.listWebhookEndpoints();
  const endpoint = endpoints.find((candidate) => candidate.id === id.data);
  if (!endpoint) throw notFound('Webhook not found');
  const now = services.clock.now();
  const eventId = `test:${now.toISOString()}`;
  await services.db.enqueueWebhookDelivery({
    endpointId: endpoint.id,
    event: 'post.generated',
    eventId,
    payload: {
      id: eventId,
      type: 'ping',
      occurredAt: now.toISOString(),
      apiVersion: '2026-11-01',
      source: { app: 'postpilot', url: services.config.baseUrl },
      data: { test: true, endpoint: endpoint.name },
    },
    nextAttemptAt: now.toISOString(),
  });
  return ok(c, { queued: true, eventId, note: 'It is delivered by the next cron tick.' });
});

export const OMNI_API_KEY_PREFIX = API_KEY_PREFIX;
export const omniApiKeyHash = hashApiKey;
