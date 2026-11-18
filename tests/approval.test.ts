import { describe, expect, it } from 'vitest';
import { decideApproval, previewApproval, resendApprovalEmail } from '@/src/core/approval';
import { generateDailyPost } from '@/src/core/generation';
import { sweepPublishing } from '@/src/core/publishing';
import { approvalEmail, createHarness, extractTokenFromEmail, type Harness } from './helpers';

async function setup(options: { now?: string; autoPublish?: boolean } = {}): Promise<{
  harness: Harness;
  postId: string;
  token: string;
}> {
  const harness = createHarness({
    now: options.now ?? '2026-11-16T03:05:00Z',
    settings: options.autoPublish === false ? { autoPublishOnApproval: false } : {},
  });
  const result = await generateDailyPost(harness.services, { trigger: 'test' });
  if (result.status !== 'generated') throw new Error(`generation failed: ${result.status}`);
  return {
    harness,
    postId: result.post.id,
    token: extractTokenFromEmail(approvalEmail(harness).html),
  };
}

describe('email approval', () => {
  it('queues publishing for the daily publish time when approved early', async () => {
    const { harness, postId, token } = await setup();
    const outcome = await decideApproval(harness.services, {
      action: 'approve',
      token,
      actor: 'test',
    });

    expect(outcome.post.status).toBe('approved');
    expect(outcome.publish?.status).toBe('queued');
    expect(harness.linkedin.publishCalls).toHaveLength(0);

    const job = await harness.db.getJobByPost(postId);
    expect(job?.status).toBe('queued');
    expect(job?.runAt).toBe('2026-11-16T04:30:00.000Z');
    expect(harness.sheets.updates.some((update) => update.approval === 'Approved')).toBe(true);
    expect(harness.email.sent.some((message) => message.subject.startsWith('Post approved'))).toBe(
      true,
    );
  });

  it('publishes immediately when the publish time has already passed', async () => {
    const { harness, postId, token } = await setup({ now: '2026-11-16T05:00:00Z' });
    const outcome = await decideApproval(harness.services, {
      action: 'approve',
      token,
      actor: 'test',
    });

    expect(outcome.publish?.status).toBe('published');
    expect(outcome.post.status).toBe('published');
    expect(outcome.post.publishedUrl).toBe(
      'https://www.linkedin.com/feed/update/urn:li:share:999/',
    );
    expect(harness.linkedin.publishCalls).toHaveLength(1);
    expect(harness.linkedin.publishCalls[0]?.commentary).toBe(outcome.post.fullText);
    expect(harness.linkedin.publishCalls[0]?.idempotencyKey).toBe(postId);

    const job = await harness.db.getJobByPost(postId);
    expect(job?.status).toBe('published');
    expect(
      harness.sheets.updates.some((update) => update.publishedUrl?.includes('linkedin.com')),
    ).toBe(true);
    expect(harness.email.sent.some((message) => message.subject.startsWith('Published'))).toBe(
      true,
    );
  });

  it('consumes an approval token exactly once', async () => {
    const { harness, token } = await setup();
    await decideApproval(harness.services, { action: 'approve', token, actor: 'test' });

    await expect(
      decideApproval(harness.services, { action: 'approve', token, actor: 'test' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(harness.db.allApprovals()[0]?.status).toBe('approved');
    expect(harness.linkedin.publishCalls).toHaveLength(0);
  });

  it('rejects a post without publishing anything', async () => {
    const { harness, postId, token } = await setup();
    const outcome = await decideApproval(harness.services, {
      action: 'reject',
      token,
      actor: 'test',
      note: 'Too generic',
    });

    expect(outcome.post.status).toBe('rejected');
    expect(outcome.publish?.status).toBe('not_applicable');
    expect(harness.linkedin.publishCalls).toHaveLength(0);
    const topics = await harness.db.listTopics();
    expect(topics[0]?.status).toBe('skipped');
    expect(harness.sheets.updates.some((update) => update.approval === 'Rejected')).toBe(true);

    const job = await harness.db.getJobByPost(postId);
    expect(job).toBeNull();

    await expect(
      decideApproval(harness.services, { action: 'approve', token, actor: 'test' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses expired approval links', async () => {
    const { harness, token } = await setup();
    harness.clock.advanceMinutes(49 * 60);
    await expect(
      decideApproval(harness.services, { action: 'approve', token, actor: 'test' }),
    ).rejects.toMatchObject({ code: 'GONE' });
    expect(harness.linkedin.publishCalls).toHaveLength(0);

    const post = harness.db.allPosts()[0];
    expect(post?.status).toBe('pending_approval');
  });

  it('supports approving from the dashboard by post id', async () => {
    const { harness, postId } = await setup({ now: '2026-11-16T05:00:00Z' });
    const outcome = await decideApproval(harness.services, {
      action: 'approve',
      postId,
      actor: 'owner@example.com',
    });
    expect(outcome.post.status).toBe('published');
    expect(harness.linkedin.publishCalls).toHaveLength(1);
  });

  it('keeps the post approved without publishing when auto-publish is disabled', async () => {
    const { harness, postId, token } = await setup({ autoPublish: false });
    const outcome = await decideApproval(harness.services, {
      action: 'approve',
      token,
      actor: 'test',
    });
    expect(outcome.post.status).toBe('approved');
    expect(outcome.publish?.status).toBe('not_applicable');
    expect(await harness.db.getJobByPost(postId)).toBeNull();
    expect(harness.linkedin.publishCalls).toHaveLength(0);
  });

  it('reports preview states without side effects', async () => {
    const { harness, token } = await setup();

    const actionable = await previewApproval(harness.services, token);
    expect(actionable.state).toBe('actionable');
    expect(actionable.post?.status).toBe('pending_approval');

    const invalid = await previewApproval(harness.services, 'not-a-real-token');
    expect(invalid.state).toBe('invalid');

    await decideApproval(harness.services, { action: 'reject', token, actor: 'test' });
    const used = await previewApproval(harness.services, token);
    expect(used.state).toBe('used');
    expect(used.action).toBe('reject');

    const { harness: expiredHarness, token: expiredToken } = await setup();
    expiredHarness.clock.advanceMinutes(49 * 60);
    expect((await previewApproval(expiredHarness.services, expiredToken)).state).toBe('expired');
  });

  it('rotates the token when the approval email is re-sent', async () => {
    const { harness, postId, token } = await setup();
    const result = await resendApprovalEmail(harness.services, postId, 'owner@example.com');
    expect(result.sent).toBe(true);

    const emails = harness.email.sent.filter((message) =>
      message.html.includes('/approve/?token='),
    );
    expect(emails).toHaveLength(2);
    const newToken = extractTokenFromEmail(emails[1]!.html);
    expect(newToken).not.toBe(token);

    await expect(
      decideApproval(harness.services, { action: 'approve', token, actor: 'test' }),
    ).rejects.toMatchObject({ code: 'GONE' });

    const outcome = await decideApproval(harness.services, {
      action: 'approve',
      token: newToken,
      actor: 'test',
    });
    expect(outcome.post.status).toBe('approved');
  });

  it('publishes queued posts once the publish time arrives', async () => {
    const { harness, token } = await setup();
    await decideApproval(harness.services, { action: 'approve', token, actor: 'test' });
    expect(harness.linkedin.publishCalls).toHaveLength(0);

    harness.clock.set('2026-11-16T04:35:00Z'); // 09:35 Karachi
    const outcomes = await sweepPublishing(harness.services);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('published');
    expect(harness.linkedin.publishCalls).toHaveLength(1);

    harness.clock.advanceMinutes(5);
    expect(await sweepPublishing(harness.services)).toHaveLength(0);
    expect(harness.linkedin.publishCalls).toHaveLength(1);
  });
});
