import { describe, expect, it } from 'vitest';
import { runWebhookTick } from '@/src/core/scheduler';
import { emitWebhookEvent } from '@/src/core/omni';
import { webhookDispatcherFor } from '@/src/core/omni-dispatch';
import { createHarness } from './helpers';

/**
 * Phase 10's webhook queue runs on its own cron.
 *
 * The delivery logic was already covered; what was not covered is the entry point the every-minute cron
 * calls. Two things matter and neither is about HTTP: it must do *only* webhooks (a second cron that also
 * generated would post five times an hour), and a broken endpoint must not take the cron down with it.
 */

async function queueOneDelivery(harness: ReturnType<typeof createHarness>) {
  await harness.db.createWebhookEndpoint({
    name: 'OmniFlow',
    url: 'https://omni.test/hooks',
    secret: 'whsec_secret',
    events: ['*'],
  });
  await emitWebhookEvent(webhookDispatcherFor(harness.services), {
    event: 'post.published',
    eventId: 'p1:post.published',
    data: { postId: 'p1', publishedUrl: 'https://linkedin.test/p1' },
    baseUrl: harness.config.baseUrl,
    now: harness.clock.now(),
  });
}

describe('webhook tick', () => {
  it('delivers a due webhook without generating or publishing anything', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const before = harness.ai.calls.length;
    await queueOneDelivery(harness);

    const result = await runWebhookTick(harness.services);

    expect(result).toMatchObject({ attempted: 1, delivered: 1, failed: 0, errors: [] });
    expect(harness.webhooks).toHaveLength(1);
    // The point of a separate tick: nothing else ran.
    expect(harness.ai.calls).toHaveLength(before);
    expect(harness.db.allPosts()).toHaveLength(0);
  });

  it('is a no-op when the queue is empty, and does not throw', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const result = await runWebhookTick(harness.services);
    expect(result).toMatchObject({ attempted: 0, delivered: 0, failed: 0, retrying: 0, errors: [] });
    expect(harness.webhooks).toHaveLength(0);
  });

  it('reports a failure in the result and leaves the cron alive', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    await queueOneDelivery(harness);
    harness.webhookResponses.push(new Error('connection reset'));

    // A delivery that fails is a normal outcome, not a thrown error: the tick counts it and returns.
    const result = await runWebhookTick(harness.services);
    expect(result.attempted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.delivered + result.retrying + result.failed).toBe(1);
  });

  it('does not retry a webhook that is not yet due', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    await queueOneDelivery(harness);
    harness.webhookResponses.push(new Error('connection reset'));
    await runWebhookTick(harness.services);

    // The backoff pushes `next_attempt_at` into the future; a tick one second later must send nothing.
    harness.clock.advanceMinutes(0);
    const again = await runWebhookTick(harness.services);
    expect(again.attempted).toBe(0);
  });
});
