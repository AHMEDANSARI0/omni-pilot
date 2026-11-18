import { describe, expect, it } from 'vitest';
import {
  markManualPublished,
  publishPost,
  retryPublish,
  sweepPublishing,
} from '@/src/core/publishing';
import { AppError } from '@/src/core/errors';
import { generateDailyPost } from '@/src/core/generation';
import { createHarness, type Harness } from './helpers';

async function approvedPost(
  now = '2026-11-16T05:00:00Z',
): Promise<{ harness: Harness; postId: string }> {
  const harness = createHarness({ now });
  const result = await generateDailyPost(harness.services, { trigger: 'test' });
  if (result.status !== 'generated') throw new Error('generation failed');
  const post = await harness.db.updatePost(result.post.id, { status: 'approved' });
  await harness.db.createJob({ postId: post.id, runAt: now });
  return { harness, postId: post.id };
}

describe('LinkedIn publishing', () => {
  it('publishes once and records the LinkedIn URL', async () => {
    const { harness, postId } = await approvedPost();
    const outcome = await publishPost(harness.services, postId, { actor: 'test' });

    expect(outcome.status).toBe('published');
    expect(outcome.post?.status).toBe('published');
    expect(outcome.post?.externalId).toBe('urn:li:share:999');
    expect(outcome.url).toContain('linkedin.com');

    const job = await harness.db.getJobByPost(postId);
    expect(job?.status).toBe('published');
    expect(job?.publishedAt).not.toBeNull();
    expect(harness.linkedin.publishCalls).toHaveLength(1);
  });

  it('is idempotent: a second publish attempt calls LinkedIn only once', async () => {
    const { harness, postId } = await approvedPost();
    await publishPost(harness.services, postId, { actor: 'test' });
    const second = await publishPost(harness.services, postId, { actor: 'test' });

    expect(second.status).toBe('already_published');
    expect(harness.linkedin.publishCalls).toHaveLength(1);
  });

  it('refuses to publish a post that is not approved', async () => {
    const harness = createHarness();
    const result = await generateDailyPost(harness.services, { trigger: 'test' });
    if (result.status !== 'generated') throw new Error('generation failed');

    const outcome = await publishPost(harness.services, result.post.id, { actor: 'test' });
    expect(outcome.status).toBe('not_publishable');
    expect(harness.linkedin.publishCalls).toHaveLength(0);
  });

  it('falls back to manual publishing when LinkedIn is not connected, and never fakes success', async () => {
    const { harness, postId } = await approvedPost();
    harness.linkedin.connected = false;
    harness.linkedin.needsReauth = true;

    const outcome = await publishPost(harness.services, postId, { actor: 'test' });
    expect(outcome.status).toBe('manual_required');
    expect(outcome.post?.status).toBe('approved');
    expect(outcome.post?.publishedAt).toBeNull();
    expect(outcome.post?.errorMessage).toContain('Manual publishing required');

    const job = await harness.db.getJobByPost(postId);
    expect(job?.status).toBe('manual_required');
    expect(
      harness.email.sent.some((message) => message.subject.includes('Manual publish needed')),
    ).toBe(true);
    expect(harness.linkedin.publishCalls).toHaveLength(0);
  });

  it('schedules a retry with backoff for transient failures, then succeeds', async () => {
    const { harness, postId } = await approvedPost();
    harness.linkedin.failures = [
      new AppError('LINKEDIN_ERROR', 'Upstream 503', { retryable: true }),
    ];

    const first = await publishPost(harness.services, postId, { actor: 'test' });
    expect(first.status).toBe('retry_scheduled');
    expect(first.post?.status).toBe('approved');
    const job = await harness.db.getJobByPost(postId);
    expect(job?.status).toBe('queued');
    expect(job?.runAt).toBe('2026-11-16T05:02:00.000Z');

    harness.clock.set('2026-11-16T05:03:00Z');
    const outcomes = await sweepPublishing(harness.services);
    expect(outcomes[0]?.status).toBe('published');
    expect(harness.linkedin.publishCalls).toHaveLength(2);
  });

  it('marks the post failed after exhausting retries and notifies', async () => {
    const { harness, postId } = await approvedPost();
    harness.linkedin.failures = [
      new AppError('LINKEDIN_ERROR', 'timeout', { retryable: true }),
      new AppError('LINKEDIN_ERROR', 'timeout', { retryable: true }),
      new AppError('LINKEDIN_ERROR', 'timeout', { retryable: true }),
    ];

    const first = await publishPost(harness.services, postId, { actor: 'test' });
    expect(first.status).toBe('retry_scheduled');
    harness.clock.advanceMinutes(3);
    const second = await publishPost(harness.services, postId, { actor: 'test' });
    expect(second.status).toBe('retry_scheduled');
    harness.clock.advanceMinutes(6);
    const third = await publishPost(harness.services, postId, { actor: 'test' });

    expect(third.status).toBe('failed');
    expect(third.post?.status).toBe('failed');
    expect(third.post?.errorMessage).toContain('timeout');
    const job = await harness.db.getJobByPost(postId);
    expect(job?.status).toBe('failed');
    expect(
      harness.email.sent.some((message) => message.subject.includes('Automation failure')),
    ).toBe(true);
  });

  it('does not retry content rejections (non-retryable 422)', async () => {
    const { harness, postId } = await approvedPost();
    harness.linkedin.failures = [
      new AppError('LINKEDIN_ERROR', 'LinkedIn rejected the post (422)', { retryable: false }),
    ];
    const outcome = await publishPost(harness.services, postId, { actor: 'test' });
    expect(outcome.status).toBe('failed');
    expect(harness.linkedin.publishCalls).toHaveLength(1);
  });

  it('allows retrying a failed post', async () => {
    const { harness, postId } = await approvedPost();
    await harness.db.updatePost(postId, { status: 'failed', errorMessage: 'boom' });
    const result = await retryPublish(harness.services, postId, 'owner@example.com');
    expect(result.post.status).toBe('approved');
    expect(result.job.status).toBe('queued');

    const outcome = await publishPost(harness.services, postId, { actor: 'test' });
    expect(outcome.status).toBe('published');
  });

  it('records a manual publish with URL validation and audit trail', async () => {
    const { harness, postId } = await approvedPost();
    await expect(
      markManualPublished(
        harness.services,
        postId,
        'https://example.com/post',
        'owner@example.com',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const result = await markManualPublished(
      harness.services,
      postId,
      'https://www.linkedin.com/feed/update/urn:li:share:1234/',
      'owner@example.com',
    );
    expect(result.post.status).toBe('published');
    expect(result.post.publishedUrl).toContain('urn:li:share:1234');

    const logs = await harness.db.listLogs({ event: 'publish.manual_recorded' });
    expect(logs).toHaveLength(1);

    await expect(
      markManualPublished(
        harness.services,
        postId,
        'https://www.linkedin.com/feed/update/x/',
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('recovers posts left in the publishing state by a crashed worker', async () => {
    const { harness, postId } = await approvedPost();
    await harness.db.updatePost(postId, { status: 'publishing' });
    const job = await harness.db.getJobByPost(postId);
    await harness.db.updateJob(job!.id, {
      status: 'processing',
      lockedUntil: new Date(Date.parse('2026-11-16T04:00:00Z')).toISOString(),
    });

    const sweep = await sweepPublishing(harness.services);
    expect(sweep).toHaveLength(1);
    expect(sweep[0]?.status).toBe('published');
  });
});
