import { AppError } from './errors';
import { buildApprovalEmail, buildDecisionReceiptEmail } from './emails';
import { createLogger } from './logger';
import { sendOwnerEmail } from './notify';
import { cancelQueuedJob, publishPost, type PublishStatus } from './publishing';
import { publishRunAt, slotOfPost } from './schedule';
import { approvalSheetUpdate, safeSheetUpdate } from './sync';
import { addHours, isoInstant } from './time';
import { generateApprovalToken, hashApprovalToken, isApprovalTokenFormatValid } from './tokens';
import type { Services } from './services';
import type { Approval, Post } from './types';

export type PublishDecision = {
  status: PublishStatus | 'queued' | 'not_applicable';
  jobId: string | null;
  url: string | null;
  message: string;
};

export interface DecisionOutcome {
  action: 'approve' | 'reject';
  post: Post;
  approval: Approval;
  publish: PublishDecision | null;
  sheetUpdated: boolean;
}

export interface DecisionInput {
  action: 'approve' | 'reject';
  actor: string;
  token?: string;
  postId?: string;
  note?: string;
}

export type ApprovalPreviewState = 'actionable' | 'expired' | 'used' | 'invalid';

export interface ApprovalPreview {
  state: ApprovalPreviewState;
  message: string;
  post: Post | null;
  approval: Approval | null;
  action: 'approve' | 'reject' | null;
  expiresAt: string | null;
}

/** Read-only view used by the approval page that the email links to. */
export async function previewApproval(services: Services, token: string): Promise<ApprovalPreview> {
  if (!isApprovalTokenFormatValid(token)) {
    return {
      state: 'invalid',
      message: 'This approval link is not valid.',
      post: null,
      approval: null,
      action: null,
      expiresAt: null,
    };
  }
  const tokenHash = await hashApprovalToken(token, services.config.auth.approvalTokenSecret);
  const approval = await services.db.getApprovalByTokenHash(tokenHash);
  if (!approval) {
    return {
      state: 'invalid',
      message: 'This approval link is unknown. It may have been replaced by a newer link.',
      post: null,
      approval: null,
      action: null,
      expiresAt: null,
    };
  }
  const post = await services.db.getPost(approval.postId);
  if (approval.status !== 'pending') {
    return {
      state: approval.status === 'expired' ? 'expired' : 'used',
      message:
        approval.status === 'expired'
          ? 'This approval link has expired. The post stays unpublished.'
          : `This post was already ${approval.status}. No further action is possible from this link.`,
      post,
      approval,
      action:
        approval.action === 'approve' || approval.action === 'reject' ? approval.action : null,
      expiresAt: approval.expiresAt,
    };
  }
  if (new Date(approval.expiresAt).getTime() <= services.clock.now().getTime()) {
    return {
      state: 'expired',
      message: 'This approval link has expired. The post stays unpublished.',
      post,
      approval,
      action: null,
      expiresAt: approval.expiresAt,
    };
  }
  return {
    state: 'actionable',
    message: 'Approve or reject this post. Nothing is published until you approve.',
    post,
    approval,
    action: null,
    expiresAt: approval.expiresAt,
  };
}

/**
 * Approve or reject a post. The token is consumed atomically, so a double tap, a replayed
 * request or a stale email can never publish twice or publish a rejected post.
 */
export async function decideApproval(
  services: Services,
  input: DecisionInput,
): Promise<DecisionOutcome> {
  const log = createLogger(services.db, { actor: input.actor, extra: { action: input.action } });
  const settings = await services.db.getSettings();

  let tokenHash: string | null = null;
  if (input.token) {
    if (!isApprovalTokenFormatValid(input.token)) {
      throw new AppError('NOT_FOUND', 'Approval link is not valid.');
    }
    tokenHash = await hashApprovalToken(input.token, services.config.auth.approvalTokenSecret);
  } else if (input.postId) {
    const active = await services.db.getActiveApprovalForPost(input.postId);
    if (!active) {
      const post = await services.db.getPost(input.postId);
      if (!post) throw new AppError('NOT_FOUND', 'Post not found.');
      throw new AppError(
        'CONFLICT',
        `No pending approval for this post (status: ${post.status}).`,
        {
          details: { postStatus: post.status },
        },
      );
    }
    tokenHash = active.tokenHash;
  } else {
    throw new AppError('BAD_REQUEST', 'Provide an approval token or post id.');
  }

  const consumed = await services.db.consumeApproval(tokenHash, input.action);
  if (!consumed) {
    const existing = await services.db.getApprovalByTokenHash(tokenHash);
    if (!existing) throw new AppError('NOT_FOUND', 'Approval link is not valid or was replaced.');
    if (
      existing.status === 'expired' ||
      new Date(existing.expiresAt).getTime() <= services.clock.now().getTime()
    ) {
      throw new AppError('GONE', 'This approval link has expired. The post stays unpublished.', {
        details: { expiresAt: existing.expiresAt },
      });
    }
    throw new AppError('CONFLICT', `This post was already ${existing.status}. No action taken.`, {
      details: { approvalStatus: existing.status, action: existing.action },
    });
  }

  const post = await services.db.getPost(consumed.postId);
  if (!post) throw new AppError('NOT_FOUND', 'The post for this approval no longer exists.');

  if (input.action === 'approve') {
    if (post.status === 'published') {
      await log.info(
        'approval.already_published',
        'Approval recorded but post was already published',
        {
          postId: post.id,
        },
      );
      return {
        action: 'approve',
        post,
        approval: consumed,
        publish: {
          status: 'already_published',
          jobId: null,
          url: post.publishedUrl,
          message: 'Already published.',
        },
        sheetUpdated: false,
      };
    }
    if (!['pending_approval', 'approved'].includes(post.status)) {
      throw new AppError('CONFLICT', `Post is in status "${post.status}" and cannot be approved.`, {
        details: { postStatus: post.status },
      });
    }

    const approvedPost = await services.db.updatePost(post.id, {
      status: 'approved',
      errorMessage: null,
    });
    const topic = approvedPost.topicId ? await services.db.getTopic(approvedPost.topicId) : null;
    const sheetUpdated = await safeSheetUpdate(
      services,
      log,
      approvalSheetUpdate(topic, 'approve'),
      'approval.sheet_updated',
    );

    let publish: PublishDecision | null = null;
    if (settings.autoPublishOnApproval) {
      const runAt = publishRunAt(settings, services.clock.now());
      const job = await services.db.createJob({
        postId: approvedPost.id,
        runAt: isoInstant(runAt),
        status: 'queued',
      });
      if (runAt.getTime() <= services.clock.now().getTime() + 60_000) {
        const outcome = await publishPost(services, approvedPost.id, {
          actor: `${input.actor}:approval`,
        });
        publish = {
          status: outcome.status,
          jobId: outcome.job?.id ?? job.id,
          url: outcome.url,
          message: outcome.message,
        };
        const finalPost =
          outcome.post ?? (await services.db.getPost(approvedPost.id)) ?? approvedPost;
        await log.info('approval.approved', 'Post approved and publish attempted', {
          postId: approvedPost.id,
          publishStatus: outcome.status,
        });
        await sendReceipt(services, log, 'approve', finalPost, outcome.status, outcome.url);
        return {
          action: 'approve',
          post: finalPost,
          approval: consumed,
          publish,
          sheetUpdated,
        };
      }
      publish = {
        status: 'queued',
        jobId: job.id,
        url: null,
        message: `Publishing queued for ${new Intl.DateTimeFormat('en-GB', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: settings.ownerTimezone,
        }).format(runAt)} (${settings.ownerTimezone}).`,
      };
    } else {
      publish = {
        status: 'not_applicable',
        jobId: null,
        url: null,
        message: 'Automatic publishing is disabled. Publish from the dashboard when ready.',
      };
    }

    await log.info('approval.approved', 'Post approved', {
      postId: approvedPost.id,
      publishStatus: publish.status,
      note: input.note ?? null,
    });
    await sendReceipt(services, log, 'approve', approvedPost, publish.status, publish.url);
    await emitDecisionEvent(services, 'approve', approvedPost);

    return { action: 'approve', post: approvedPost, approval: consumed, publish, sheetUpdated };
  }

  if (post.status === 'published') {
    throw new AppError('CONFLICT', 'This post is already published and cannot be rejected.');
  }
  const rejectedPost = await services.db.updatePost(post.id, {
    status: 'rejected',
    errorMessage: input.note ?? null,
  });
  if (rejectedPost.topicId) {
    await services.db
      .updateTopic(rejectedPost.topicId, { status: 'skipped', lastError: 'Rejected by owner' })
      .catch(() => undefined);
  }
  await cancelQueuedJob(services, rejectedPost.id);
  const topic = rejectedPost.topicId ? await services.db.getTopic(rejectedPost.topicId) : null;
  const sheetUpdated = await safeSheetUpdate(
    services,
    log,
    approvalSheetUpdate(topic, 'reject'),
    'approval.sheet_updated',
  );
  await log.info('approval.rejected', 'Post rejected; nothing was published', {
    postId: rejectedPost.id,
    note: input.note ?? null,
  });
  await sendReceipt(services, log, 'reject', rejectedPost, 'rejected', null);
  await emitDecisionEvent(services, 'reject', rejectedPost);

  return {
    action: 'reject',
    post: rejectedPost,
    approval: consumed,
    publish: {
      status: 'not_applicable',
      jobId: null,
      url: null,
      message: 'Rejected - nothing was published.',
    },
    sheetUpdated,
  };
}

/** Issue a fresh token and re-send the approval email (old links stop working). */
export async function resendApprovalEmail(
  services: Services,
  postId: string,
  actor: string,
): Promise<{ sent: boolean; error: string | null; expiresAt: string }> {
  const log = createLogger(services.db, { actor, extra: { postId } });
  const settings = await services.db.getSettings();
  const post = await services.db.getPost(postId);
  if (!post) throw new AppError('NOT_FOUND', 'Post not found.');
  if (post.status !== 'pending_approval') {
    throw new AppError(
      'CONFLICT',
      `Only posts awaiting approval can be re-sent (status: ${post.status}).`,
    );
  }

  const existing = await services.db.getActiveApprovalForPost(postId);
  if (existing) {
    await services.db.updateApproval(existing.id, {
      status: 'expired',
      usedAt: isoInstant(services.clock.now()),
    });
  }

  const token = generateApprovalToken();
  const tokenHash = await hashApprovalToken(token, services.config.auth.approvalTokenSecret);
  const expiresAt = isoInstant(addHours(services.clock.now(), settings.approvalTtlHours));
  const approval = await services.db.createApproval({ postId, tokenHash, expiresAt });

  const topic = post.topicId ? await services.db.getTopic(post.topicId) : null;
  const reviewUrl = `${services.config.baseUrl}/approve/?token=${encodeURIComponent(token)}`;
  const rejectUrl = `${services.config.baseUrl}/approve/?token=${encodeURIComponent(token)}&intent=reject`;
  const result = await sendOwnerEmail(
    services,
    log,
    buildApprovalEmail({ post, topic, reviewUrl, rejectUrl, expiresAt, settings }),
  );
  if (result.sent) {
    await services.db.updateApproval(approval.id, {
      emailSentAt: isoInstant(services.clock.now()),
      emailMessageId: result.messageId,
    });
  }
  await log.info(
    'approval.resent',
    result.sent ? 'Approval email re-sent' : 'Approval email re-send failed',
    {
      postId,
      error: result.error,
    },
  );
  return { sent: result.sent, error: result.error, expiresAt };
}

/**
 * Phase 10: OmniFlow hears about an approval decision. Fire-and-forget - a webhook endpoint being down
 * must not turn an approval into an error, and the delivery is retried by the cron tick.
 */
async function emitDecisionEvent(
  services: Services,
  action: 'approve' | 'reject',
  post: Post,
): Promise<void> {
  try {
    const { emitWebhookEvent } = await import('./omni');
    const { webhookDispatcherFor } = await import('./omni-dispatch');
    await emitWebhookEvent(webhookDispatcherFor(services), {
      event: action === 'approve' ? 'post.approved' : 'post.rejected',
      eventId: `${post.id}:post.${action === 'approve' ? 'approved' : 'rejected'}`,
      data: { postId: post.id, runDate: post.runDate, slotIndex: post.slotIndex },
      baseUrl: services.config.baseUrl,
      now: services.clock.now(),
    });
  } catch {
    // Nothing to add: the dispatcher logs its own failures when it attempts the delivery.
  }
}

async function sendReceipt(
  services: Services,
  log: ReturnType<typeof createLogger>,
  action: 'approve' | 'reject',
  post: Post,
  publishStatus: string,
  publishedUrl: string | null,
): Promise<void> {
  const settings = await services.db.getSettings();
  await sendOwnerEmail(
    services,
    log,
    buildDecisionReceiptEmail({ action, post, publishStatus, publishedUrl, settings }),
  );
}
