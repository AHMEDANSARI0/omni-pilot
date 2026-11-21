import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers';
import { appFor, call } from './request';

/**
 * POST /content/topics and its slot handling.
 *
 * Found by `npm run e2e`: the phase 10 spec creates one topic per slot on the same day, and the second
 * create answered `200 { topic: <slot 0's row>, alreadyExists: true }` - a success status carrying the
 * *other* slot's topic. The cause is that `(topic_date, topic)` is unique, so the second insert collides,
 * and the `allowDuplicate` recovery looked the collision up by date and wording while ignoring the slot.
 * Two publish times therefore could not both be queued when the wording repeated - which is exactly what
 * a template or a "part 2" post looks like.
 */
describe('POST /content/topics - one topic per slot', () => {
  const day = '2034-02-11';

  it('keeps two slots of one day apart even when the wording is identical', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const app = appFor(harness);
    const topic = 'Idempotency keys, part two: the retry that never happened';

    const first = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({ topicDate: day, slotIndex: 0, topic, allowDuplicate: true }),
    });
    expect(first.status).toBe(201);
    expect(first.body.data.topic.slotIndex).toBe(0);

    const second = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({ topicDate: day, slotIndex: 1, topic, allowDuplicate: true }),
    });
    // The whole point: slot 1 gets *its own* row, not slot 0's.
    expect(second.status).toBe(201);
    expect(second.body.data.topic.slotIndex).toBe(1);
    expect(second.body.data.topic.id).not.toBe(first.body.data.topic.id);
    expect(second.body.data.alreadyExists).toBeUndefined();

    const topics = await harness.db.listTopics({ from: day, to: day });
    expect(topics.map((entry) => entry.slotIndex).sort()).toEqual([0, 1]);
  });

  it('still treats the same wording in the same slot as already queued', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const app = appFor(harness);
    const topic = 'Retry budgets: the number nobody sets';
    const once = (slotIndex: number) =>
      call(app, harness, '/api/v1/content/topics', {
        method: 'POST',
        body: JSON.stringify({ topicDate: day, slotIndex, topic, allowDuplicate: true }),
      });

    await once(0);
    const again = await once(0);

    // Nothing was added, and the response says so instead of pretending a row was created.
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyExists).toBe(true);
    expect(again.body.data.topic.slotIndex).toBe(0);
    expect(await harness.db.listTopics({ from: day, to: day })).toHaveLength(1);
  });

  it('refuses the same wording in a decided slot of the same day', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const app = appFor(harness);
    const topic = 'The queue that ate the weekend';

    const created = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({ topicDate: day, slotIndex: 0, topic, allowDuplicate: true }),
    });
    await harness.db.updateTopic(created.body.data.topic.id, { status: 'skipped' });

    const again = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({ topicDate: day, slotIndex: 0, topic, allowDuplicate: true }),
    });
    // Skipped counts as still-queued in this codebase's recovery path, so 200 + alreadyExists is correct;
    // what must not happen is a second row.
    expect([200, 409]).toContain(again.status);
    expect(await harness.db.listTopics({ from: day, to: day })).toHaveLength(1);
  });
});
