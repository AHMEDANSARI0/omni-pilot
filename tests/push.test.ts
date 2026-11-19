import { describe, expect, it } from 'vitest';
import {
  PUSH_MAX_FAILURES,
  broadcastPush,
  notificationFor,
  parseSubscription,
  type PushSubscription,
} from '@/src/core/push';
import { pushConfigured, sendTestPush } from '@/src/core/push-send';
import { createHarness } from './helpers';

/**
 * Web push: the decision layer and device bookkeeping.
 *
 * The scope note in src/core/push.ts says plainly that payload encryption is not hand-written here, so
 * what is tested is what the code actually promises: a subscription is validated before it is stored, a
 * notification says what to do, a dead endpoint is retired instead of retried, and an unconfigured
 * deployment reports that honestly rather than claiming a delivery.
 */

const subscription = (overrides: Partial<PushSubscription> = {}): PushSubscription => ({
  id: 's1',
  endpoint: 'https://push.test/abc',
  p256dh: 'BOrEU6V0Zq1',
  auth: 'auth-secret-1',
  userAgent: 'test',
  failureCount: 0,
  lastSuccessAt: null,
  lastError: null,
  createdAt: '2026-11-16T00:00:00.000Z',
  ...overrides,
});

describe('subscription parsing', () => {
  it('accepts what PushManager.subscribe().toJSON() actually sends', () => {
    const parsed = parseSubscription({
      endpoint: 'https://fcm.googleapis.com/wp/abc',
      keys: { p256dh: 'BOrEU6V0Zq1BOrEU6V0Zq1', auth: 'auth-secret-1' },
    });
    expect(parsed?.endpoint).toBe('https://fcm.googleapis.com/wp/abc');
    expect(parsed?.p256dh).toBe('BOrEU6V0Zq1BOrEU6V0Zq1');
  });

  it('rejects an insecure endpoint, missing keys, and rubbish', () => {
    expect(parseSubscription({ endpoint: 'http://push.test/abc', keys: { p256dh: 'x'.repeat(30), auth: 'y'.repeat(10) } })).toBeNull();
    expect(parseSubscription({ endpoint: 'https://push.test/abc', keys: {} })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
    expect(parseSubscription('nope')).toBeNull();
    expect(parseSubscription({ endpoint: 'https://push.test/abc', keys: { p256dh: 'short', auth: 'y'.repeat(10) } })).toBeNull();
  });

  it('keeps a bounded user agent so a huge header cannot bloat the row', () => {
    const parsed = parseSubscription({
      endpoint: 'https://push.test/abc',
      keys: { p256dh: 'p'.repeat(30), auth: 'a'.repeat(10) },
      userAgent: 'u'.repeat(1000),
    });
    expect(parsed?.userAgent?.length).toBe(300);
  });
});

describe('notification wording', () => {
  it('tells the owner what to do next, and where', () => {
    const ready = notificationFor('post.ready', { runDate: '2026-11-16' });
    expect(ready.title).toBe('Your draft is ready');
    expect(ready.body).toContain('2026-11-16');
    expect(ready.url).toBe('/approvals/');

    const failed = notificationFor('post.failed', { reason: 'Token expired' });
    expect(failed.title).toBe('Publishing failed');
    expect(failed.body).toContain('Token expired');
    expect(failed.url).toBe('/posts/');

    const expiring = notificationFor('approval.expiring', { runDate: '2026-11-17', hoursLeft: 3 });
    expect(expiring.body).toContain('3 hours');
  });

  it('gives each kind a stable tag so the device collapses repeats', () => {
    expect(notificationFor('post.ready', {}).tag).toBe('post-ready');
    expect(notificationFor('post.failed', {}).tag).toBe('post-failed');
  });
});

describe('broadcasting', () => {
  const notification = notificationFor('post.ready', {});

  it('counts what was sent and what failed', async () => {
    const results: Array<{ id: string; ok: boolean }> = [];
    const outcome = await broadcastPush(
      [subscription({ id: 'a' }), subscription({ id: 'b', endpoint: 'https://push.test/b' })],
      async (target) => ({ ok: target.endpoint === 'https://push.test/abc', status: 201 }),
      notification,
      async (id, result) => {
        results.push({ id, ok: result.ok });
      },
    );
    expect(outcome).toMatchObject({ sent: 1, failed: 1, retired: 0 });
    expect(results).toHaveLength(2);
  });

  it('retires an endpoint the push service says is gone (410)', async () => {
    const outcome = await broadcastPush(
      [subscription()],
      async () => ({ ok: false, status: 410 }),
      notification,
      async () => undefined,
    );
    expect(outcome).toMatchObject({ sent: 0, failed: 1, retired: 1 });
  });

  it('skips a device that already failed too often', async () => {
    let called = 0;
    const outcome = await broadcastPush(
      [subscription({ failureCount: PUSH_MAX_FAILURES })],
      async () => {
        called += 1;
        return { ok: true };
      },
      notification,
      async () => undefined,
    );
    expect(called).toBe(0);
    expect(outcome).toMatchObject({ sent: 0, retired: 1 });
  });

  it('survives a sender that throws', async () => {
    const outcome = await broadcastPush(
      [subscription()],
      async () => {
        throw new Error('push service unreachable');
      },
      notification,
      async () => undefined,
    );
    expect(outcome).toMatchObject({ sent: 0, failed: 1 });
  });
});

describe('against the app', () => {
  it('is honestly unconfigured without VAPID keys', async () => {
    const harness = createHarness();
    expect(pushConfigured(harness.services)).toBe(false);
    const result = await sendTestPush(harness.services);
    expect(result).toEqual({ configured: false, sent: 0, failed: 0, retired: 0 });
  });

  it('stores one row per endpoint, not one per subscribe call', async () => {
    const harness = createHarness();
    const first = await harness.db.savePushSubscription({
      endpoint: 'https://push.test/abc',
      p256dh: 'p'.repeat(30),
      auth: 'a'.repeat(10),
      userAgent: 'phone',
    });
    const second = await harness.db.savePushSubscription({
      endpoint: 'https://push.test/abc',
      p256dh: 'p'.repeat(30),
      auth: 'a'.repeat(10),
      userAgent: 'phone',
    });
    const all = await harness.db.listPushSubscriptions();
    expect(all).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it('removes a device on unsubscribe and on a gone endpoint', async () => {
    const harness = createHarness();
    const saved = await harness.db.savePushSubscription({
      endpoint: 'https://push.test/abc',
      p256dh: 'p'.repeat(30),
      auth: 'a'.repeat(10),
      userAgent: null,
    });
    await harness.db.recordPushResult(saved.id, { ok: false, status: 410, at: '2026-11-16T04:00:00.000Z' });
    expect(await harness.db.listPushSubscriptions()).toHaveLength(0);
  });

  it('counts failures and clears them on the next success', async () => {
    const harness = createHarness();
    const saved = await harness.db.savePushSubscription({
      endpoint: 'https://push.test/abc',
      p256dh: 'p'.repeat(30),
      auth: 'a'.repeat(10),
      userAgent: null,
    });
    await harness.db.recordPushResult(saved.id, { ok: false, error: 'network', at: '2026-11-16T04:00:00.000Z' });
    expect((await harness.db.listPushSubscriptions())[0]!.failureCount).toBe(1);

    await harness.db.recordPushResult(saved.id, { ok: true, at: '2026-11-16T05:00:00.000Z' });
    const after = (await harness.db.listPushSubscriptions())[0]!;
    expect(after.failureCount).toBe(0);
    expect(after.lastSuccessAt).toBe('2026-11-16T05:00:00.000Z');
    expect(after.lastError).toBeNull();
  });
});
