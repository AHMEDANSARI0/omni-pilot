import { describe, expect, it } from 'vitest';
import { createHarness, testConfig } from '../helpers';
import { appFor, call } from './request';

describe('Phase 6 - planning endpoints', () => {
  const suggestion = {
    topic: 'Idempotency keys for agent tool calls',
    angle: 'Failure story',
    keyPoints: 'a\nb',
    audience: 'engineers',
    contentType: 'story',
  };

  it('POST /content/suggestions returns dated suggestions without storing them', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    harness.ai.suggestTopics = async () =>
      JSON.stringify({
        suggestions: [suggestion, { ...suggestion, topic: 'Typed failures in agent workflows' }],
      });
    const app = appFor(harness);

    const { status, body } = await call(app, harness, '/api/v1/content/suggestions', {
      method: 'POST',
      body: JSON.stringify({ count: 2 }),
    });

    expect(status).toBe(200);
    expect(body.data.suggestions).toHaveLength(2);
    expect(body.data.suggestions[0].topicDate).toBe('2026-11-17');
    // Nothing is written until the owner accepts.
    expect(await harness.db.listTopics()).toHaveLength(0);
  });

  it('POST /content/suggestions/accept adds topics and refuses a taken date', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const app = appFor(harness);

    const first = await call(app, harness, '/api/v1/content/suggestions/accept', {
      method: 'POST',
      body: JSON.stringify({
        topics: [
          { topicDate: '2026-11-17', topic: 'Idempotency keys for agent tool calls', contentType: 'story' },
          { topicDate: '2026-11-18', topic: 'Typed failures in agent workflows', contentType: 'how-to' },
        ],
      }),
    });
    expect(first.status).toBe(200);
    expect(first.body.data.added).toBe(2);

    const second = await call(app, harness, '/api/v1/content/suggestions/accept', {
      method: 'POST',
      body: JSON.stringify({
        topics: [{ topicDate: '2026-11-17', topic: 'A completely different topic', contentType: 'insight' }],
      }),
    });
    expect(second.body.data.added).toBe(0);
    expect(second.body.data.skipped[0].reason).toContain('already has a topic');
    expect(await harness.db.listTopics()).toHaveLength(2);
  });

  it('POST /content/suggestions fails loudly when the provider cannot plan', async () => {
    const harness = createHarness();
    const app = appFor(harness);
    const { status, body } = await call(app, harness, '/api/v1/content/suggestions', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error.message).toMatch(/cannot propose topics/);
  });

  it('GET /calendar returns a month grid plus the gaps still to fill', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    await harness.db.createTopic({
      sheetRowNumber: null,
      topicDate: '2026-11-17',
      topic: 'Idempotency keys for agent tool calls',
      contentType: 'insight',
      keyPoints: null,
      targetAudience: null,
    });
    const app = appFor(harness);

    const { status, body } = await call(app, harness, '/api/v1/calendar?month=2026-11');
    expect(status).toBe(200);
    expect(body.data.month).toBe('2026-11');
    expect(body.data.weeks.flat()).toHaveLength(body.data.weeks.length * 7);
    expect(body.data.totals.pending).toBe(1);
    expect(body.data.gaps).not.toContain('2026-11-17');
    expect(body.data.gaps).toContain('2026-11-18');
  });

  it('GET /calendar falls back to the current month for a bad parameter', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const app = appFor(harness);
    const { body } = await call(app, harness, '/api/v1/calendar?month=not-a-month');
    expect(body.data.month).toBe('2026-11');
  });
});
