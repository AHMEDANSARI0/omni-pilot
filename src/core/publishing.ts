import { AppError, isAppError, safeErrorMessage } from './errors';
import { buildManualPublishEmail, buildPublishedEmail } from './emails';
import { createLogger } from './logger';
import { notifyFailure, sendOwnerEmail } from './notify';
import { MAX_PUBLISH_ATTEMPTS, PUBLISH_BACKOFF_MINUTES, type Services } from './services';
import { publishedSheetUpdate, safeSheetUpdate } from './sync';
import { addMinutes, isoInstant } from './time';
import type { Job, Post } from './types';

export type PublishStatus =
  | 'published'
  | 'already_published'
  | 'manual_required'
  | 'retry_scheduled'
  | 'failed'
  | 'in_progress'
  | 'not_publishable';

export interface PublishOutcome {
  status: PublishStatus;
  postId: string;
  post: Post | null;
  job: Job | null;
  url: string | null;
  message: string;
}

/**
 * Publish one approved post through the LinkedIn adapter.
 *
 * Duplicate-publish protection is layered:
 *  1. `claimPostForPublish` atomically moves approved -> publishing (one winner).
 *  2. A unique publishing_jobs row per post.
 *  3. An early return when the post row already has a published timestamp.
 */
export async function publishPost(
  services: Services,
  postId: string,
  options: { jobId?: string; actor?: string } = {},
): Promise<PublishOutcome> {
  const actor = options.actor ?? 'system';
  const log = createLogger(services.db, { actor, extra: { postId } });
  const now = services.clock.now();

  let post = await services.db.getPost(postId);
  if (!post) {
    return {
      status: 'not_publishable',
      postId,
      post: null,
      job: null,
      url: null,
      message: 'Post not found',
    };
  }

  let job = options.jobId
    ? await services.db.getJob(options.jobId)
    : await services.db.getJobByPost(postId);
  if (!job) {
    job = await services.db.createJob({ postId, runAt: isoInstant(now) });
  }

  if (job.status === 'published' || post.status === 'published') {
    if (job.status !== 'published') {
      job = await services.db.updateJob(job.id, {
        status: 'published',
        postUrl: post.publishedUrl,
        publishedAt: post.publishedAt,
        externalId: post.externalId,
      });
    }
    return {
      status: 'already_published',
      postId,
      post,
      job,
      url: post.publishedUrl,
      message: 'Post is already published; nothing was sent to LinkedIn.',
    };
  }

  if (!options.jobId) {
    job = await services.db.updateJob(job.id, {
      status: 'processing',
      attempts: job.attempts + 1,
      lockedUntil: isoInstant(addMinutes(now, 10)),
      lastError: null,
    });
  }

  const claimed = await services.db.claimPostForPublish(postId);
  if (!claimed) {
    const current = await services.db.getPost(postId);
    if (current?.status === 'publishing') {
      await log.info('publish.in_progress', 'Another worker already claimed this post');
      return {
        status: 'in_progress',
        postId,
        post: current,
        job,
        url: null,
        message: 'Publishing is already in progress.',
      };
    }
    await services.db
      .updateJob(job.id, {
        status: 'canceled',
        lastError: `Post status is ${current?.status ?? 'unknown'}`,
      })
      .catch(() => undefined);
    return {
      status: 'not_publishable',
      postId,
      post: current,
      job,
      url: null,
      message: `Post is not approved (current status: ${current?.status ?? 'missing'}).`,
    };
  }
  post = claimed;

  const linkedIn = await services.linkedin.status();
  if (!linkedIn.connected) {
    const reason = linkedIn.needsReauth
      ? 'LinkedIn authorization is missing or expired. Reconnect LinkedIn, then publish again.'
      : 'LinkedIn is not connected. Connect it in Settings, then publish again.';
    return manualFallback(services, post, job, reason, log);
  }

  try {
    const result = await services.linkedin.publish({
      commentary: post.fullText,
      idempotencyKey: post.id,
    });

    const publishedAt = isoInstant(services.clock.now());
    const updatedPost = await services.db.updatePost(post.id, {
      status: 'published',
      externalId: result.externalId,
      publishedUrl: result.url,
      publishedAt,
      errorMessage: null,
    });
    job = await services.db.updateJob(job.id, {
      status: 'published',
      externalId: result.externalId,
      postUrl: result.url,
      publishedAt,
      lockedUntil: null,
      lastError: null,
    });

    const topic = updatedPost.topicId ? await services.db.getTopic(updatedPost.topicId) : null;
    await safeSheetUpdate(
      services,
      log,
      publishedSheetUpdate(topic, result.url, 'Published'),
      'publish.sheet_updated',
    );

    await log.info('publish.succeeded', `Published to LinkedIn: ${result.url}`, {
      externalId: result.externalId,
      attempts: job.attempts,
    });

    const settings = await services.db.getSettings();
    await sendOwnerEmail(services, log, buildPublishedEmail(updatedPost, result.url, settings));

    await emitPostEvent(services, 'post.published', postId, {
      postId,
      runDate: updatedPost.runDate,
      slotIndex: updatedPost.slotIndex,
      publishedUrl: result.url,
    });

    return {
      status: 'published',
      postId,
      post: updatedPost,
      job,
      url: result.url,
      message: 'Published to LinkedIn.',
    };
  } catch (error) {
    const reason = safeErrorMessage(error);
    const needsReauth =
      isAppError(error) &&
      (error.details?.needsReauth === true || error.details?.needsManualCheck === true);
    const retryable = isAppError(error) ? error.retryable : true;

    if (needsReauth) {
      return manualFallback(services, post, job, reason, log);
    }

    if (retryable && job.attempts < MAX_PUBLISH_ATTEMPTS) {
      const backoff =
        PUBLISH_BACKOFF_MINUTES[Math.min(job.attempts - 1, PUBLISH_BACKOFF_MINUTES.length - 1)] ??
        5;
      const runAt = isoInstant(addMinutes(services.clock.now(), backoff));
      job = await services.db.updateJob(job.id, {
        status: 'queued',
        runAt,
        lockedUntil: null,
        lastError: reason,
      });
      const restored = await services.db.updatePost(post.id, {
        status: 'approved',
        errorMessage: reason,
      });
      await log.warn('publish.retry_scheduled', `Publish failed, retrying at ${runAt}: ${reason}`, {
        attempts: job.attempts,
      });
      return {
        status: 'retry_scheduled',
        postId,
        post: restored,
        job,
        url: null,
        message: `Publish failed and will retry in ${backoff} minutes: ${reason}`,
      };
    }

    job = await services.db.updateJob(job.id, {
      status: 'failed',
      lockedUntil: null,
      lastError: reason,
    });
    const failedPost = await services.db.updatePost(post.id, {
      status: 'failed',
      errorMessage: reason,
    });
    await log.error('publish.failed', `Publishing failed permanently: ${reason}`, {
      attempts: job.attempts,
    });
    await emitPostEvent(services, 'post.failed', postId, {
      postId,
      runDate: post.runDate,
      reason,
    });
    await pushEvent(services, 'post.failed', { runDate: post.runDate, reason });
    const settings = await services.db.getSettings();
    await notifyFailure(services, log, {
      runDate: post.runDate,
      stage: 'LinkedIn publishing',
      message: `${reason}\n\nThe post was NOT published. You can retry from the dashboard once the issue is fixed.`,
    });
    void settings;
    return {
      status: 'failed',
      postId,
      post: failedPost,
      job,
      url: null,
      message: `Publishing failed: ${reason}`,
    };
  }
}

async function manualFallback(
  services: Services,
  post: Post,
  job: Job,
  reason: string,
  log: ReturnType<typeof createLogger>,
): Promise<PublishOutcome> {
  const updatedJob = await services.db.updateJob(job.id, {
    status: 'manual_required',
    lockedUntil: null,
    lastError: reason,
  });
  const restored = await services.db.updatePost(post.id, {
    status: 'approved',
    errorMessage: `Manual publishing required: ${reason}`,
  });
  await log.warn('publish.manual_required', reason, { postId: post.id });
  const settings = await services.db.getSettings();
  await sendOwnerEmail(services, log, buildManualPublishEmail(post, reason, settings));
  return {
    status: 'manual_required',
    postId: post.id,
    post: restored,
    job: updatedJob,
    url: null,
    message: `Automatic publishing was not possible. Approved content is available for manual posting: ${reason}`,
  };
}

/** Publish everything that is due. Called by the 5-minute cron tick. */
export async function sweepPublishing(services: Services, limit = 5): Promise<PublishOutcome[]> {
  const recovered = await services.db.recoverStuckJobs().catch(() => 0);
  const log = createLogger(services.db, { actor: 'scheduler' });
  if (recovered > 0) {
    await log.warn(
      'publish.recovered_stuck_jobs',
      `Recovered ${recovered} interrupted publishing job(s)`,
    );
  }

  const due = await services.db.claimDueJobs(limit);
  const outcomes: PublishOutcome[] = [];
  for (const job of due) {
    outcomes.push(await publishPost(services, job.postId, { jobId: job.id, actor: 'scheduler' }));
  }
  return outcomes;
}

/** Explicit retry after a terminal failure. */
export async function retryPublish(
  services: Services,
  postId: string,
  actor: string,
): Promise<{ post: Post; job: Job }> {
  const post = await services.db.getPost(postId);
  if (!post) throw new AppError('NOT_FOUND', `Post ${postId} not found`);
  if (post.status === 'published') {
    throw new AppError('CONFLICT', 'Post is already published.');
  }
  if (!['failed', 'approved', 'rejected', 'expired'].includes(post.status)) {
    throw new AppError('CONFLICT', `Post in status "${post.status}" cannot be republished.`);
  }
  const now = isoInstant(services.clock.now());
  const updatedPost = await services.db.updatePost(postId, {
    status: 'approved',
    errorMessage: null,
  });
  const job =
    (await services.db.getJobByPost(postId)) ??
    (await services.db.createJob({ postId, runAt: now }));
  const updatedJob = await services.db.updateJob(job.id, {
    status: 'queued',
    runAt: now,
    lockedUntil: null,
    lastError: null,
  });
  await createLogger(services.db, { actor }).info(
    'publish.retry_requested',
    'Publishing retry queued',
    {
      postId,
      previousStatus: post.status,
    },
  );
  return { post: updatedPost, job: updatedJob };
}

/** Record a post the owner published by hand (manual fallback path). */
export async function markManualPublished(
  services: Services,
  postId: string,
  url: string,
  actor: string,
): Promise<{ post: Post; job: Job | null }> {
  if (!/^https:\/\/(www\.)?(linkedin\.com|lnkd\.in)\//i.test(url)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Provide the LinkedIn post URL (https://www.linkedin.com/...).',
    );
  }
  const post = await services.db.getPost(postId);
  if (!post) throw new AppError('NOT_FOUND', `Post ${postId} not found`);
  if (post.status === 'published' && post.publishedUrl) {
    throw new AppError('CONFLICT', 'Post is already recorded as published.');
  }

  const publishedAt = isoInstant(services.clock.now());
  const updatedPost = await services.db.updatePost(postId, {
    status: 'published',
    publishedUrl: url,
    publishedAt,
    errorMessage: null,
  });
  const job = await services.db.getJobByPost(postId);
  const updatedJob = job
    ? await services.db.updateJob(job.id, {
        status: 'published',
        postUrl: url,
        publishedAt,
        lockedUntil: null,
        lastError: null,
      })
    : null;

  const topic = updatedPost.topicId ? await services.db.getTopic(updatedPost.topicId) : null;
  const log = createLogger(services.db, { actor });
  await safeSheetUpdate(
    services,
    log,
    publishedSheetUpdate(topic, url, 'Published'),
    'publish.manual_sheet_updated',
  );
  await log.info('publish.manual_recorded', 'Manual publish recorded', { postId, url });
  return { post: updatedPost, job: updatedJob };
}

/** Cancel any queued job for a post (used when a post is rejected). */
export async function cancelQueuedJob(services: Services, postId: string): Promise<void> {
  const job = await services.db.getJobByPost(postId);
  if (!job) return;
  if (job.status === 'queued' || job.status === 'processing') {
    await services.db.updateJob(job.id, {
      status: 'canceled',
      lockedUntil: null,
      lastError: 'Post was rejected',
    });
  }
}

/**
 * Phase 10: tells OmniFlow that something happened.
 *
 * Fire-and-forget by design: an unreachable webhook endpoint must never turn a successful publish into
 * an error the owner sees, and the delivery itself is retried by the cron tick.
 */
/**
 * Phase 10: the same three moments that get a webhook also get a push notification, for the owner's
 * phone. Fire-and-forget and unconfigured-safe: an owner without VAPID keys is not an error.
 */
async function pushEvent(
  services: Services,
  event: 'post.ready' | 'post.failed',
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const { broadcastPushEvent } = await import('./push-send');
    await broadcastPushEvent(services, event, data);
  } catch {
    // A notification that cannot be sent must never fail the publish that triggered it.
  }
}

async function emitPostEvent(
  services: Services,
  event: 'post.published' | 'post.failed' | 'post.generated' | 'post.approved' | 'post.rejected',
  postId: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const { emitWebhookEvent } = await import('./omni');
    const { webhookDispatcherFor } = await import('./omni-dispatch');
    await emitWebhookEvent(webhookDispatcherFor(services), {
      event,
      // One delivery per post per event: a retried publish cannot notify twice.
      eventId: `${postId}:${event}`,
      data,
      baseUrl: services.config.baseUrl,
      now: services.clock.now(),
    });
  } catch {
    // Logged by the dispatcher when the delivery is attempted; nothing to add here.
  }
}
