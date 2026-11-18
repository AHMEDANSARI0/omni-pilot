import { describe, expect, it } from 'vitest';
import { runAutomationTick } from '@/src/core/scheduler';
import { createHarness } from './helpers';

describe('automation tick', () => {
  it('does nothing before the configured generation time', async () => {
    const harness = createHarness({ now: '2026-11-16T02:30:00Z' }); // 07:30 Karachi
    const result = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(result.generation.attempted).toBe(false);
    expect(result.generation.reason).toContain('Scheduled for 08:00');
    expect(harness.db.allPosts()).toHaveLength(0);
  });

  it('generates once per day even when the tick runs repeatedly', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' }); // 08:05 Karachi, Monday
    const first = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(first.generation.attempted).toBe(true);
    expect(first.generation.result?.status).toBe('generated');

    harness.clock.advanceMinutes(5);
    const second = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(second.generation.attempted).toBe(false);
    expect(second.generation.reason).toContain('Already generated today');
    expect(harness.db.allPosts()).toHaveLength(1);
    expect(harness.ai.calls).toHaveLength(1);
  });

  it('does not run on a non-publish day', async () => {
    const harness = createHarness({ now: '2026-11-21T04:00:00Z' }); // Saturday
    const result = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(result.generation.attempted).toBe(false);
    expect(result.generation.reason).toContain('Not a scheduled publish day');
  });

  it('retries after a failure, up to the daily attempt limit', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    harness.ai.responses = [
      new Error('provider down'),
      new Error('provider down'),
      new Error('provider down'),
      new Error('provider down'),
      new Error('provider down'),
      new Error('provider down'),
    ];

    const first = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(first.generation.result?.status).toBe('failed');
    expect((await harness.db.getSchedulerState()).lastGenerationStatus).toBe('failed');

    harness.clock.advanceMinutes(5);
    const second = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(second.generation.attempted).toBe(true);

    harness.clock.advanceMinutes(5);
    const third = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(third.generation.attempted).toBe(true);

    harness.clock.advanceMinutes(5);
    const fourth = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(fourth.generation.attempted).toBe(false);
    expect(fourth.generation.reason).toContain('attempt limit');
    // One AI call per run (the provider adapter owns transport retries), three runs allowed.
    expect(harness.ai.calls).toHaveLength(3);
  });

  it('publishes due jobs during the tick', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    const generation = await runAutomationTick(harness.services, {
      trigger: 'manual',
      force: true,
    });
    expect(generation.generation.result?.status).toBe('generated');

    const post = harness.db.allPosts()[0]!;
    await harness.db.updatePost(post.id, { status: 'approved' });
    await harness.db.createJob({ postId: post.id, runAt: '2026-11-16T05:00:00Z' });

    const tick = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(tick.publishing).toHaveLength(1);
    expect(tick.publishing[0]?.status).toBe('published');
    expect((await harness.db.getPost(post.id))?.status).toBe('published');
  });

  it('expires stale approvals during the tick', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    await runAutomationTick(harness.services, { trigger: 'manual', force: true });
    harness.clock.advanceMinutes(60 * 72);

    const tick = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(tick.expiredApprovals).toBe(1);
    const post = harness.db.allPosts()[0];
    expect(post?.status).toBe('expired');
  });

  it('never throws when a dependency misbehaves', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    harness.sheets.failReads = true;
    const result = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(result.errors).toEqual([]);
    expect(result.generation.result?.status).toBe('no_topic');
  });

  it('warns before the LinkedIn token expires', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    harness.linkedin.expiresAt = '2026-11-18T03:00:00Z'; // 2 days away
    const tick = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(tick.linkedInWarningSent).toBe(true);
    expect(
      harness.email.sent.some((message) => message.subject.includes('LinkedIn access expires')),
    ).toBe(true);

    harness.clock.advanceMinutes(10);
    const second = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(second.linkedInWarningSent).toBe(false);
  });
});
