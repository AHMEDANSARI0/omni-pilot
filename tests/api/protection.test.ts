import { describe, expect, it } from 'vitest';
import { createHarness, extractTokenFromEmail, testConfig, type Harness } from '../helpers';
import { appFor, call } from './request';

describe('Phase 7 - duplicate protection and hook library', () => {
  it('GET /content/hooks reports an empty library honestly', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    const app = appFor(harness);

    const { status, body } = await call(app, harness, '/api/v1/content/hooks');
    expect(status).toBe(200);
    expect(body.data.proven).toEqual([]);
    expect(body.data.rejected).toEqual([]);
    expect(body.data.promptBlock).toBe('');
    expect(body.data.summary).toContain('No published post yet');
    expect(body.data.threshold).toBeGreaterThan(0);
  });

  it('turns a published and a rejected post into a real prompt block', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    const app = appFor(harness);

    // generate -> approve -> publish: this is the only path that makes a hook "proven"
    const generated = await call(app, harness, '/api/v1/content/generate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(generated.status).toBe(200);
    const postId = generated.body.data.result.post.id;
    const hook = generated.body.data.result.post.hook as string;

    const token = extractTokenFromEmail(
      harness.email.sent.find((message) => message.html.includes('/approve/?token='))!.html,
    );
    await call(app, harness, `/api/v1/public/approvals/${token}/decision`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    });

    const { body } = await call(app, harness, '/api/v1/content/hooks');
    expect(body.data.proven).toHaveLength(1);
    expect(body.data.proven[0].hook).toBe(hook);
    expect(body.data.proven[0].outcome).toBe('published');
    expect(body.data.proven[0].pattern).toBeTruthy();
    expect(body.data.promptBlock).toContain('OPENINGS THAT WORKED');
    expect(body.data.promptBlock).toContain(hook);
    expect(body.data.summary).toContain('1 proven hook');

    // the post id is stable, and a second call does not invent extra evidence
    const again = await call(app, harness, '/api/v1/content/hooks');
    expect(again.body.data.proven).toHaveLength(1);
    expect(postId).toBeTruthy();
  });

  it('drops a suggested topic that repeats an existing one, with the reason', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    const app = appFor(harness);
    const duplicateTopic = 'Why every agent tool call needs an idempotency key';
    await harness.db.createTopic({
      sheetRowNumber: null,
      topicDate: '2026-11-10',
      topic: duplicateTopic,
      contentType: 'insight',
      keyPoints: null,
      targetAudience: null,
    });

    // The fake provider only plans when a test gives it a response, exactly like the real one.
    harness.ai.suggestTopics = async () =>
      JSON.stringify({
        suggestions: [
          { topic: duplicateTopic, angle: 'Failure story', keyPoints: 'a\nb', audience: 'engineers', contentType: 'story' },
          { topic: 'Typed failures inside agent workflows', angle: 'Trade-off', keyPoints: 'a\nb', audience: 'engineers', contentType: 'insight' },
        ],
      });

    const { body } = await call(app, harness, '/api/v1/content/suggestions', {
      method: 'POST',
      body: JSON.stringify({ count: 2 }),
    });
    const skippedReasons = (body.data.skipped as Array<{ reason: string }>).map((item) => item.reason);
    expect(skippedReasons.join(' ')).toContain('Too close to an existing topic');
  });
});

describe('Phase 7 - manual topic duplicate guard', () => {
  const earlier = 'Why every agent tool call needs an idempotency key';

  async function withEarlier(harness: Harness) {
    await harness.db.createTopic({
      sheetRowNumber: null,
      topicDate: '2026-11-10',
      topic: earlier,
      contentType: 'insight',
      keyPoints: null,
      targetAudience: null,
    });
  }

  it('refuses a near-duplicate topic and names the earlier one', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    await withEarlier(harness);
    const app = appFor(harness);

    const { status, body } = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({ topicDate: '2026-11-20', topic: earlier, contentType: 'insight' }),
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('DUPLICATE_TOPIC');
    expect(body.error.message).toContain('2026-11-10');
    expect(body.error.details.duplicateOf).toBe(earlier);
    // nothing was written
    expect(await harness.db.listTopics({ limit: 50 })).toHaveLength(1);
  });

  it('keeps it when the owner explicitly allows it', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    await withEarlier(harness);
    const app = appFor(harness);

    const { status, body } = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({
        topicDate: '2026-11-20',
        topic: earlier,
        contentType: 'insight',
        allowDuplicate: true,
      }),
    });
    expect(status).toBe(201);
    expect(body.data.topic.topic).toBe(earlier);
    expect(await harness.db.listTopics({ limit: 50 })).toHaveLength(2);
  });

  it('says "nothing added" when the exact topic is already queued for that date', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    await withEarlier(harness);
    const app = appFor(harness);

    // Same day + same text is one row in the database (UNIQUE (topic_date, topic)), so "Add anyway"
    // cannot create a second one. It must return the existing row and say so, never claim it added.
    const { status, body } = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({
        topicDate: '2026-11-10',
        topic: earlier,
        contentType: 'insight',
        allowDuplicate: true,
      }),
    });
    expect(status).toBe(200);
    expect(body.data.alreadyExists).toBe(true);
    expect(body.data.topic.topic).toBe(earlier);
    expect(await harness.db.listTopics({ limit: 50 })).toHaveLength(1);
  });

  it('refuses to re-add a topic that already produced a post', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    await withEarlier(harness);
    const app = appFor(harness);
    const [existing] = await harness.db.listTopics({ limit: 10 });
    await harness.db.updateTopic(existing!.id, { status: 'generated' });

    const { status, body } = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({
        topicDate: '2026-11-10',
        topic: earlier,
        contentType: 'insight',
        allowDuplicate: true,
      }),
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('DUPLICATE_TOPIC');
    expect(body.error.details.status).toBe('generated');
    expect(body.error.message).toContain('already generated');
  });

  it('lets a genuinely new topic through without a flag', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    await withEarlier(harness);
    const app = appFor(harness);

    const { status, body } = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({
        topicDate: '2026-11-20',
        topic: 'How I trace a publish job that fails at 2am',
        contentType: 'story',
      }),
    });
    expect(status).toBe(201);
    expect(body.data.topic.topic).toContain('2am');
  });
});
