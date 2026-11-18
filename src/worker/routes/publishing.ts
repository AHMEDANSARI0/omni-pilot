import { Hono } from 'hono';
import { AppError } from '@/src/core/errors';
import { markManualPublished, publishPost, retryPublish } from '@/src/core/publishing';
import { JOB_STATUSES, type JobStatus } from '@/src/core/types';
import { fail, notFound, ok } from '../http';
import { manualPublishSchema, parseOrThrow } from '../schemas';
import type { AppEnv } from '../types';

export const publishingRoutes = new Hono<AppEnv>();

publishingRoutes.get('/jobs', async (c) => {
  const services = c.get('services');
  const statusParam = c.req.query('status');
  const statuses = statusParam
    ? (statusParam
        .split(',')
        .filter((value) => JOB_STATUSES.includes(value as JobStatus)) as JobStatus[])
    : undefined;
  const jobs = await services.db.listJobs({ statuses, limit: Number(c.req.query('limit') ?? 100) });
  const enrichments = await Promise.all(
    jobs.map(async (job) => ({ job, post: await services.db.getPost(job.postId) })),
  );
  return ok(c, { jobs: enrichments.filter((entry) => entry.post !== null) });
});

publishingRoutes.get('/history', async (c) => {
  const services = c.get('services');
  const posts = await services.db.listPosts({ statuses: ['published'], limit: 100 });
  return ok(c, {
    history: posts.map((post) => ({
      id: post.id,
      runDate: post.runDate,
      publishedUrl: post.publishedUrl,
      publishedAt: post.publishedAt,
      hook: post.hook,
      charCount: post.charCount,
      source: post.source,
    })),
  });
});

publishingRoutes.post('/posts/:postId/publish', async (c) => {
  const services = c.get('services');
  const postId = c.req.param('postId');
  const post = await services.db.getPost(postId);
  if (!post) return fail(c, notFound('Post not found'));
  if (post.status !== 'approved') {
    return fail(
      c,
      new AppError(
        'CONFLICT',
        `Only approved posts can be published (current status: ${post.status}).`,
      ),
    );
  }
  const outcome = await publishPost(services, postId, { actor: c.get('actor') });
  return ok(c, outcome);
});

publishingRoutes.post('/posts/:postId/retry', async (c) => {
  const services = c.get('services');
  try {
    const result = await retryPublish(services, c.req.param('postId'), c.get('actor'));
    return ok(c, result);
  } catch (error) {
    return fail(c, error);
  }
});

publishingRoutes.post('/posts/:postId/manual', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(manualPublishSchema, await c.req.json().catch(() => ({})));
  try {
    const result = await markManualPublished(
      services,
      c.req.param('postId'),
      body.url,
      c.get('actor'),
    );
    return ok(c, result);
  } catch (error) {
    return fail(c, error);
  }
});
