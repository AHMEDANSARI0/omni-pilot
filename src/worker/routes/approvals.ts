import { Hono } from 'hono';
import { decideApproval, previewApproval, resendApprovalEmail } from '@/src/core/approval';
import { rateLimit } from '@/src/worker/middleware/rate-limit';
import { fail, notFound, ok } from '../http';
import {
  approvalDecisionSchema,
  approvalQuerySchema,
  dashboardDecisionSchema,
  parseOrThrow,
} from '../schemas';
import type { AppEnv } from '../types';

/** Authenticated approval management for the dashboard. */
export const approvalRoutes = new Hono<AppEnv>();

approvalRoutes.get('/', async (c) => {
  const services = c.get('services');
  const query = parseOrThrow(approvalQuerySchema, {
    status: c.req.query('status') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
  });
  const statuses = (query.status ? query.status.split(',') : ['pending']) as Array<
    'pending' | 'approved' | 'rejected' | 'expired'
  >;
  const approvals = await services.db.listApprovals({ statuses, limit: query.limit ?? 50 });
  const posts = await Promise.all(
    approvals.map(async (approval) => ({
      approval,
      post: await services.db.getPost(approval.postId),
    })),
  );
  return ok(c, { approvals: posts.filter((entry) => entry.post !== null) });
});

approvalRoutes.post('/:postId/decision', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(dashboardDecisionSchema, await c.req.json().catch(() => ({})));
  try {
    const outcome = await decideApproval(services, {
      action: body.action,
      postId: c.req.param('postId'),
      actor: c.get('actor'),
      note: body.note,
    });
    return ok(c, outcome);
  } catch (error) {
    return fail(c, error);
  }
});

approvalRoutes.post('/:postId/resend', async (c) => {
  const services = c.get('services');
  const result = await resendApprovalEmail(services, c.req.param('postId'), c.get('actor'));
  return ok(c, result);
});

/**
 * Public, token-protected endpoints used by the approval page linked from email.
 * The token is the credential; actions are POST-only and single-use.
 */
export const publicApprovalRoutes = new Hono<AppEnv>();

const publicLimiter = rateLimit({
  scope: 'public-approval',
  windowSeconds: 60,
  max: 20,
});

publicApprovalRoutes.get('/:token', publicLimiter, async (c) => {
  const services = c.get('services');
  const preview = await previewApproval(services, c.req.param('token'));
  if (preview.state === 'invalid') return fail(c, notFound(preview.message));
  return ok(c, preview);
});

publicApprovalRoutes.post('/:token/decision', publicLimiter, async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(approvalDecisionSchema, await c.req.json().catch(() => ({})));
  try {
    const outcome = await decideApproval(services, {
      action: body.action,
      token: c.req.param('token'),
      actor: 'owner:email',
      note: body.note,
    });
    return ok(c, {
      action: outcome.action,
      postStatus: outcome.post.status,
      publish: outcome.publish,
      post: {
        id: outcome.post.id,
        runDate: outcome.post.runDate,
        publishedUrl: outcome.post.publishedUrl,
        status: outcome.post.status,
      },
    });
  } catch (error) {
    // Surface a friendly, non-technical message on the approval page.
    return fail(c, error);
  }
});
