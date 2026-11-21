import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers';
import { appFor, call } from './request';

/**
 * POST /content/generate has to generate the slot it was asked for.
 *
 * Found by `npm run e2e` on the owner's machine. The phase 10 spec queues one topic per slot, generates
 * slot 0, then generates slot 1 - and slot 1 answered `status: "duplicate"`, because the route called
 * `generateDailyPost` without the slot. The core was right all along; the route above it dropped the value,
 * so the "has this day been generated" check looked at slot 0's post and found it.
 *
 * The same class of bug as `POST /content/topics` returning slot 0 for a slot-1 request: a caller asks for
 * something, the layer in between discards it, and the success status makes it look fine. These tests drive
 * the HTTP surface, because that is the layer that was wrong.
 */
describe('POST /content/generate - one post per slot', () => {
  const day = '2034-02-12';

  async function queue(app: ReturnType<typeof appFor>, harness: Parameters<typeof call>[1], slotIndex: number) {
    const created = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify({
        topicDate: day,
        slotIndex,
        topic: `Slot ${slotIndex} of ${day}: what the retry loop taught us`,
        allowDuplicate: true,
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.data.topic.slotIndex).toBe(slotIndex);
  }

  it('generates a post in the second slot instead of reporting a duplicate', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const app = appFor(harness);
    await queue(app, harness, 0);
    await queue(app, harness, 1);

    const slot0 = await call(app, harness, '/api/v1/content/generate', {
      method: 'POST',
      body: JSON.stringify({ runDate: day, slotIndex: 0 }),
    });
    expect(slot0.status, JSON.stringify(slot0.body)).toBe(200);
    expect(slot0.body.data.result.status).toBe('generated');
    expect(slot0.body.data.result.post.slotIndex).toBe(0);

    const slot1 = await call(app, harness, '/api/v1/content/generate', {
      method: 'POST',
      body: JSON.stringify({ runDate: day, slotIndex: 1 }),
    });
    expect(slot1.status, JSON.stringify(slot1.body)).toBe(200);
    // This was `duplicate`: the route never passed the slot down.
    expect(slot1.body.data.result.status).toBe('generated');
    expect(slot1.body.data.result.post.slotIndex).toBe(1);
    expect(slot1.body.data.result.post.id).not.toBe(slot0.body.data.result.post.id);
  });

  it('still reports a duplicate when the same slot is generated twice', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const app = appFor(harness);
    await queue(app, harness, 1);

    const first = await call(app, harness, '/api/v1/content/generate', {
      method: 'POST',
      body: JSON.stringify({ runDate: day, slotIndex: 1 }),
    });
    expect(first.body.data.result.status).toBe('generated');

    const again = await call(app, harness, '/api/v1/content/generate', {
      method: 'POST',
      body: JSON.stringify({ runDate: day, slotIndex: 1 }),
    });
    expect(again.body.data.result.status).toBe('duplicate');
    expect(harness.db.allPosts()).toHaveLength(1);
  });
});
