import { Hono } from 'hono';
import { generateDailyPost } from '@/src/core/generation';
import { createLogger } from '@/src/core/logger';
import { syncTopicsFromSheet } from '@/src/core/sync';
import { fail, notFound, ok } from '../http';
import { parseOrThrow, generateSchema } from '../schemas';
import type { AppEnv } from '../types';

/** Manual runs plus the counters the dashboard tiles read. */
export const runRoutes = new Hono<AppEnv>();

const R = runRoutes;

R.post('/sync', async (c) => {
  const services = c.get('services');
  const log = createLogger(services.db, { actor: c.get('actor') });
  try {
    const result = await syncTopicsFromSheet(services, log);
    return ok(c, result);
  } catch (error) {
    return fail(c, error);
  }
});

R.post('/generate', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(generateSchema, await c.req.json().catch(() => ({})));
  const result = await generateDailyPost(services, {
    runDate: body.runDate,
    slotIndex: body.slotIndex ?? 0,
    sendEmail: body.sendEmail,
    skipSync: body.skipSync,
    trigger: c.get('actor'),
  });
  return ok(c, { result });
});

R.get('/stats', async (c) => {
  const services = c.get('services');
  const [total, pending, published, failed, rejected, approved, expired] = await Promise.all([
    services.db.countPosts(),
    services.db.countPosts(['pending_approval']),
    services.db.countPosts(['published']),
    services.db.countPosts(['failed']),
    services.db.countPosts(['rejected']),
    services.db.countPosts(['approved']),
    services.db.countPosts(['expired']),
  ]);
  return ok(c, {
    total,
    pendingApprovals: pending,
    published,
    failed,
    rejected,
    approved,
    expired,
  });
});

R.post('/topics/:id/retry', async (c) => {
  const services = c.get('services');
  const topic = await services.db.getTopic(c.req.param('id'));
  if (!topic) return fail(c, notFound('Topic not found'));
  const updated = await services.db.updateTopic(topic.id, { status: 'pending', lastError: null });
  await createLogger(services.db, { actor: c.get('actor') }).info(
    'topic.reset',
    'Topic reset to pending',
    {
      topicId: topic.id,
    },
  );
  return ok(c, { topic: updated });
});
