import { describe, expect, it } from 'vitest';
import { runWebhookTick } from '@/src/core/scheduler';
import { emitWebhookEvent, WEBHOOK_MAX_ATTEMPTS } from '@/src/core/omni';
import { webhookDispatcherFor } from '@/src/core/omni-dispatch';
import { createHarness } from './helpers';

/**
 * A webhook claimed by a worker that then died must not be lost.
 *
 * `claim_webhook_deliveries` moves the row to `delivering` and counts the attempt before the HTTP call happens,
 * which is what stops two ticks sending the same event. The assumption behind it is that the worker comes back.
 * When it does not - a crash, a deploy, a killed cron invocation, Cloudflare ending the request - the row stays
 * `delivering`, `claim_webhook_deliveries` only ever selects `pending`, and nothing reports it. The endpoint
 * simply never receives that event, and the delivery log shows a row that looks in flight for ever.
 *
 * Proved on PostgreSQL 17 before this test existed: the stranded row stayed `delivering` with `attempts = 1`,
 * `next_attempt_at` in the past, and `claim_webhook_deliveries(10)` returned 0 rows.
 */
async function queueOne(harness: ReturnType<typeof createHarness>) {
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

/** Claims the due row and then does nothing with it - a worker that dies between claim and call. */
async function claimAndDie(harness: ReturnType<typeof createHarness>) {
  const claimed = await harness.db.claimWebhookDeliveries(10);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.status).toBe('delivering');
  return claimed[0]!;
}

describe('a webhook claimed by a dead worker', () => {
  it('goes back to the queue on the next tick, and is delivered', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    await queueOne(harness);
    const claimed = await claimAndDie(harness);

    // Five minutes later the cron runs again. The claim is abandoned - no process is working on it.
    harness.clock.advanceMinutes(6);

    const result = await runWebhookTick(harness.services);

    // The recovery itself is reported, so an operator can see "this many were stranded".
    expect(result.recovered).toBe(1);
    expect(result.delivered).toBe(1);
    expect(harness.webhooks).toHaveLength(1);
    expect(harness.webhooks[0]!.url).toBe('https://omni.test/hooks');
    const after = await harness.db.listWebhookDeliveries({ endpointId: claimed.endpointId });
    expect(after[0]!.status).toBe('delivered');
  });

  it('is not recovered while the claim is young - a slow receiver is not a dead worker', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    await queueOne(harness);
    await claimAndDie(harness);

    harness.clock.advanceMinutes(1);
    const result = await runWebhookTick(harness.services);

    expect(result.recovered).toBe(0);
    // Nothing was handed out twice, and nothing was delivered behind the first worker's back.
    expect(result.attempted).toBe(0);
    expect(harness.webhooks).toHaveLength(0);
  });

  it('is closed as failed instead of being retried for ever when its attempts are used up', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    await queueOne(harness);
    const claimed = await claimAndDie(harness);
    // The last attempt was spent by the worker that died.
    await harness.db.updateWebhookDelivery(claimed.id, {
      status: 'delivering',
      attempts: WEBHOOK_MAX_ATTEMPTS,
      nextAttemptAt: claimed.nextAttemptAt,
      responseStatus: null,
      responseBody: null,
      deliveredAt: null,
    });

    harness.clock.advanceMinutes(6);
    const result = await runWebhookTick(harness.services);

    expect(result.recovered).toBe(0);
    expect(result.attempted).toBe(0);
    const after = await harness.db.listWebhookDeliveries({ endpointId: claimed.endpointId });
    expect(after[0]!.status).toBe('failed');
    // It says why, so the delivery log is not a row that silently stopped moving.
    expect(after[0]!.responseBody).toMatch(/stopped before the delivery finished/);
  });
});
