import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  WEBHOOK_BACKOFF_MINUTES,
  WEBHOOK_MAX_ATTEMPTS,
  apiKeyMatches,
  buildWebhookPayload,
  deliverDueWebhooks,
  emitWebhookEvent,
  hashApiKey,
  mintApiKey,
  nextDeliveryState,
  signWebhook,
  verifyWebhookSignature,
  wantsEvent,
  webhookBackoffMinutes,
  type WebhookDelivery,
  type WebhookDispatcher,
  type WebhookEndpoint,
} from '@/src/core/omni';
import { webhookDispatcherFor } from '@/src/core/omni-dispatch';
import { createHarness } from './helpers';

/**
 * OmniFlow: keys and webhooks.
 *
 * The properties that matter are the ones an integration depends on and a bug would break quietly:
 * a key is never recoverable from the database, a signature cannot be replayed or forged, and an event is
 * delivered exactly once even when the tick that queued it runs twice.
 */

describe('API keys', () => {
  it('mints a key with a recognisable prefix and stores only its hash', () => {
    const minted = mintApiKey();
    expect(minted.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(minted.keyPrefix.startsWith(API_KEY_PREFIX)).toBe(true);
    // The prefix is what the UI shows: long enough to tell keys apart, short enough to be useless.
    expect(minted.keyPrefix.length).toBeLessThan(minted.key.length - 10);
    expect(minted.keyHash).toBe(hashApiKey(minted.key));
    expect(minted.keyHash).not.toContain(minted.key);
    expect(minted.keyHash).toHaveLength(64);
  });

  it('mints a different key every time', () => {
    const keys = new Set(Array.from({ length: 20 }, () => mintApiKey().key));
    expect(keys.size).toBe(20);
  });

  it('matches the presented key in constant time and rejects the wrong one', () => {
    const minted = mintApiKey();
    expect(apiKeyMatches(minted.key, minted.keyHash)).toBe(true);
    expect(apiKeyMatches(`${minted.key}x`, minted.keyHash)).toBe(false);
    expect(apiKeyMatches('', minted.keyHash)).toBe(false);
  });

  it('ignores surrounding whitespace (a copy-paste from a chat tends to add it)', () => {
    const minted = mintApiKey();
    expect(apiKeyMatches(`  ${minted.key}\n`, minted.keyHash)).toBe(true);
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ hello: 'world' });
  const now = 1_700_000_000_000;

  it('signs timestamp and body together, so the same body twice is two different headers', () => {
    const first = signWebhook(secret, 1_700_000_000, body);
    const second = signWebhook(secret, 1_700_000_060, body);
    expect(first).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  it('verifies a good signature inside the tolerance window', () => {
    const timestamp = Math.floor(now / 1000);
    const signature = signWebhook(secret, timestamp, body);
    expect(verifyWebhookSignature(secret, timestamp, body, signature, 300, now)).toBe(true);
  });

  it('rejects a replay outside the window', () => {
    const old = Math.floor(now / 1000) - 3600;
    const signature = signWebhook(secret, old, body);
    expect(verifyWebhookSignature(secret, old, body, signature, 300, now)).toBe(false);
  });

  it('rejects a tampered body, a wrong secret, and a malformed header', () => {
    const timestamp = Math.floor(now / 1000);
    const signature = signWebhook(secret, timestamp, body);
    expect(verifyWebhookSignature(secret, timestamp, `${body} `, signature, 300, now)).toBe(false);
    expect(verifyWebhookSignature('other', timestamp, body, signature, 300, now)).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, body, 'sha1=abc', 300, now)).toBe(false);
  });
});

describe('delivery retries', () => {
  const now = new Date('2026-11-16T04:00:00Z');

  it('delivers on success', () => {
    expect(nextDeliveryState(1, { ok: true, status: 200 }, now).status).toBe('delivered');
  });

  it('fails fast on a 4xx: the receiver understood and refused', () => {
    const state = nextDeliveryState(1, { ok: false, status: 422 }, now);
    expect(state.status).toBe('failed');
    expect(state.reason).toMatch(/rejected the payload/);
  });

  it('retries a 429, because rate limiting is temporary', () => {
    expect(nextDeliveryState(1, { ok: false, status: 429 }, now).status).toBe('pending');
  });

  it('backs off further with every attempt, then gives up', () => {
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const state = nextDeliveryState(attempt, { ok: false, status: 500 }, now);
      expect(state.status).toBe('pending');
      const delay = (new Date(state.nextAttemptAt).getTime() - now.getTime()) / 60_000;
      expect(delay).toBe(WEBHOOK_BACKOFF_MINUTES[attempt - 1]);
    }
    expect(nextDeliveryState(WEBHOOK_MAX_ATTEMPTS, { ok: false, status: 500 }, now).status).toBe(
      'failed',
    );
    expect(webhookBackoffMinutes(99)).toBe(WEBHOOK_BACKOFF_MINUTES.at(-1));
  });

  it('treats a network error like a 5xx', () => {
    const state = nextDeliveryState(2, { ok: false, error: 'ECONNRESET' }, now);
    expect(state.status).toBe('pending');
    expect(state.reason).toContain('ECONNRESET');
  });
});

describe('event subscription', () => {
  it('matches an explicit event and the wildcard, and nothing else', () => {
    expect(wantsEvent(['post.published'], 'post.published')).toBe(true);
    expect(wantsEvent(['post.published'], 'post.failed')).toBe(false);
    expect(wantsEvent(['*'], 'post.failed')).toBe(true);
    expect(wantsEvent([], 'post.failed')).toBe(false);
  });

  it('puts a version in the envelope so a receiver can adapt to a new shape', () => {
    const payload = buildWebhookPayload('post.published', { postId: 'p1' }, {
      eventId: 'e1',
      occurredAt: '2026-11-16T04:00:00.000Z',
      baseUrl: 'https://example.test',
    });
    expect(payload).toMatchObject({
      id: 'e1',
      type: 'post.published',
      apiVersion: '2026-11-01',
      data: { postId: 'p1' },
    });
    expect(payload.source).toEqual({ app: 'postpilot', url: 'https://example.test' });
  });
});

describe('dispatch against the app database', () => {
  const endpoint = (overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
    id: 'ep1',
    name: 'OmniFlow',
    url: 'https://omni.test/hooks',
    secret: 'whsec_s',
    events: ['*'],
    active: true,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  });

  function dispatcher(endpoints: WebhookEndpoint[]) {
    const deliveries: WebhookDelivery[] = [];
    const port: WebhookDispatcher = {
      listActiveEndpoints: async () => endpoints.filter((item) => item.active),
      enqueue: async (input) => {
        const duplicate = deliveries.some(
          (delivery) => delivery.endpointId === input.endpointId && delivery.eventId === input.eventId,
        );
        if (duplicate) return false;
        deliveries.push({
          id: `d${deliveries.length + 1}`,
          endpointId: input.endpointId,
          event: input.event,
          eventId: input.eventId,
          payload: input.payload,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: input.nextAttemptAt,
          responseStatus: null,
          responseBody: null,
          deliveredAt: null,
          createdAt: input.nextAttemptAt,
        });
        return true;
      },
      claimDue: async (limit) => deliveries.filter((item) => item.status === 'pending').slice(0, limit),
      finish: async (id, patch) => {
        const found = deliveries.find((item) => item.id === id);
        if (found) Object.assign(found, patch);
      },
      markEndpointResult: async () => undefined,
    };
    return { port, deliveries };
  }

  it('queues one delivery per subscribed endpoint and none for the others', async () => {
    const { port, deliveries } = dispatcher([
      endpoint({ id: 'a', events: ['post.published'] }),
      endpoint({ id: 'b', events: ['post.failed'] }),
      endpoint({ id: 'c', events: ['*'] }),
      endpoint({ id: 'd', events: ['post.published'], active: false }),
    ]);
    const queued = await emitWebhookEvent(port, {
      event: 'post.published',
      eventId: 'p1:post.published',
      data: { postId: 'p1' },
      baseUrl: 'https://example.test',
      now: new Date('2026-11-16T04:00:00Z'),
    });
    expect(queued).toBe(2);
    expect(deliveries.map((delivery) => delivery.endpointId)).toEqual(['a', 'c']);
  });

  it('is idempotent: the same event id queued twice is delivered once', async () => {
    const { port, deliveries } = dispatcher([endpoint()]);
    const input = {
      event: 'post.published' as const,
      eventId: 'p1:post.published',
      data: { postId: 'p1' },
      baseUrl: 'https://example.test',
      now: new Date('2026-11-16T04:00:00Z'),
    };
    expect(await emitWebhookEvent(port, input)).toBe(1);
    expect(await emitWebhookEvent(port, input)).toBe(0);
    expect(deliveries).toHaveLength(1);
  });

  it('sends a signed request and marks a 200 as delivered', async () => {
    const harness = createHarness();
    const created = await harness.db.createWebhookEndpoint({
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

    const result = await deliverDueWebhooks({ db: harness.db }, webhookDispatcherFor(harness.services), async (url, init) => {
      harness.webhooks.push({ url, headers: init.headers, body: init.body });
      return { status: 200, body: 'ok' };
    });

    expect(result).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
    expect(harness.webhooks).toHaveLength(1);
    const sent = harness.webhooks[0]!;
    expect(sent.url).toBe('https://omni.test/hooks');

    // The receiver must be able to verify it with nothing but the shared secret.
    const timestamp = Number(sent.headers['x-postpilot-timestamp']);
    const signature = sent.headers['x-postpilot-signature']!;
    expect(verifyWebhookSignature('whsec_secret', timestamp, sent.body, signature)).toBe(true);
    expect(JSON.parse(sent.body).type).toBe('post.published');

    const deliveries = await harness.db.listWebhookDeliveries({ endpointId: created.id });
    expect(deliveries[0]!.status).toBe('delivered');
    expect(deliveries[0]!.deliveredAt).not.toBeNull();
  });

  it('retries after a 500, and stops retrying after a 410', async () => {
    const harness = createHarness();
    await harness.db.createWebhookEndpoint({
      name: 'OmniFlow',
      url: 'https://omni.test/hooks',
      secret: 'whsec_secret',
      events: ['*'],
    });
    await emitWebhookEvent(webhookDispatcherFor(harness.services), {
      event: 'post.published',
      eventId: 'p1:post.published',
      data: {},
      baseUrl: harness.config.baseUrl,
      now: harness.clock.now(),
    });

    const retry = await deliverDueWebhooks(
      { db: harness.db },
      webhookDispatcherFor(harness.services),
      async () => ({ status: 500, body: 'boom' }),
    );
    expect(retry).toMatchObject({ attempted: 1, retrying: 1, delivered: 0 });

    const after = await harness.db.listWebhookDeliveries();
    expect(after[0]!.status).toBe('pending');
    expect(new Date(after[0]!.nextAttemptAt).getTime()).toBeGreaterThan(
      harness.clock.now().getTime(),
    );

    // The endpoint is switched off from the second consecutive failure onward? No: only after five.
    const endpoints = await harness.db.listWebhookEndpoints();
    expect(endpoints[0]!.active).toBe(true);
    expect(endpoints[0]!.failureCount).toBe(1);
  });

  it('switches an endpoint off after five consecutive failures', async () => {
    const harness = createHarness();
    const created = await harness.db.createWebhookEndpoint({
      name: 'Dead endpoint',
      url: 'https://dead.test/hooks',
      secret: 'whsec_secret',
      events: ['*'],
    });
    const dispatcherPort = webhookDispatcherFor(harness.services);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await dispatcherPort.markEndpointResult(created.id, {
        ok: false,
        error: `attempt ${attempt} failed`,
        at: harness.clock.now().toISOString(),
      });
    }
    const endpoints = await harness.db.listWebhookEndpoints();
    expect(endpoints[0]!.failureCount).toBe(5);
    expect(endpoints[0]!.active).toBe(false);
    expect(endpoints[0]!.lastError).toContain('attempt 5 failed');
  });

  it('never throws when the receiver is unreachable', async () => {
    const harness = createHarness();
    await harness.db.createWebhookEndpoint({
      name: 'Offline',
      url: 'https://offline.test/hooks',
      secret: 'whsec_secret',
      events: ['*'],
    });
    await emitWebhookEvent(webhookDispatcherFor(harness.services), {
      event: 'post.generated',
      eventId: 'p9:post.generated',
      data: {},
      baseUrl: harness.config.baseUrl,
      now: harness.clock.now(),
    });
    const result = await deliverDueWebhooks(
      { db: harness.db },
      webhookDispatcherFor(harness.services),
      async () => {
        throw new Error('getaddrinfo ENOTFOUND offline.test');
      },
    );
    expect(result).toMatchObject({ attempted: 1, failed: 0, retrying: 1 });
  });
});
