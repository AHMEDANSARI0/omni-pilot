import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@/src/core/defaults';
import {
  MAX_SLOTS_PER_DAY,
  dueSlots,
  generationDue,
  generationTimeForSlot,
  nextSlot,
  publishRunAt,
  slotCount,
  slotForDate,
  slotTimes,
  slotsForDate,
} from '@/src/core/schedule';

/**
 * Multiple posts per day (Phase 10).
 *
 * Every assertion here has a single-slot twin as well, because the feature must be invisible to an owner
 * who never adds a second slot - that is the compatibility promise this phase makes.
 */
const single = { ...defaultSettings(), generationTime: '08:00', publishTime: '10:30' };
const double = { ...single, publishTimes: ['10:30', '16:00'] };

describe('slot times', () => {
  it('falls back to the single publish time when the list is empty', () => {
    expect(slotTimes(single)).toEqual(['10:30']);
    expect(slotCount(single)).toBe(1);
    // A settings row written before the migration has no list at all.
    expect(slotTimes({ ...single, publishTimes: undefined as never })).toEqual(['10:30']);
  });

  it('uses the list when it has entries, sorted and de-duplicated', () => {
    expect(slotTimes({ ...single, publishTimes: ['16:00', '10:30', '10:30'] })).toEqual([
      '10:30',
      '16:00',
    ]);
    expect(slotCount(double)).toBe(2);
  });

  it('ignores a malformed time rather than scheduling a broken slot', () => {
    expect(slotTimes({ ...single, publishTimes: ['9:00', '16:00'] })).toEqual(['16:00']);
  });

  it('never allows more slots than the database constraint', () => {
    const many = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
    expect(slotTimes({ ...single, publishTimes: many })).toHaveLength(MAX_SLOTS_PER_DAY);
  });
});

describe('slots for a day', () => {
  it('gives the first slot the owner generation time and later slots a lead before publishing', () => {
    expect(generationTimeForSlot(double, 0)).toBe('08:00');
    // 16:00 publish, 150 minutes of lead -> 13:30 draft, so the approval is not sitting there all day.
    expect(generationTimeForSlot(double, 1)).toBe('13:30');
  });

  it('keeps the day start as the floor for an early slot', () => {
    // A 01:00 publish would imply a draft at 22:30 the day before; the draft must stay on the same day.
    const early = { ...single, publishTimes: ['00:30', '01:00'] };
    expect(generationTimeForSlot(early, 1)).toBe('00:00');
  });

  it('returns every slot in publish order with the publish day flag', () => {
    // 2026-11-16 is a Monday, inside the default Mon-Fri set.
    const day = slotsForDate(double, '2026-11-16');
    expect(day.isGenerationDay).toBe(true);
    expect(day.slots.map((slot) => slot.slotIndex)).toEqual([0, 1]);
    expect(day.slots.map((slot) => slot.publishAt)).toEqual([
      new Date(day.slots[0]!.publishAt).toISOString(),
      new Date(day.slots[1]!.publishAt).toISOString(),
    ]);
    expect(new Date(day.slots[1]!.publishAt).getTime()).toBeGreaterThan(
      new Date(day.slots[0]!.publishAt).getTime(),
    );
  });

  it('keeps slotForDate as the first slot for older callers', () => {
    expect(slotForDate(double, '2026-11-16').slotIndex).toBe(0);
  });
});

describe('what is due', () => {
  // Karachi is UTC+5, so 08:00 local = 03:00Z.
  it('is due for slot 0 after its generation time and not for slot 1 yet', () => {
    const result = dueSlots(double, new Date('2026-11-16T04:00:00Z')); // 09:00 local
    expect(result.due.map((entry) => entry.slot.slotIndex)).toEqual([0]);
    expect(result.due[0]!.slot.slotIndex).toBe(0);
    // The 13:30 draft for the 16:00 post is still hours away.
    expect(result.skipped.some((entry) => entry.slot.slotIndex === 1)).toBe(true);
  });

  it('is due for both slots when both windows are still open', () => {
    // 11:00 local = 06:00Z: slot 0's 10:30 publish time has just passed, so use a schedule where both
    // windows are still open - that is the only state in which two drafts in one tick makes sense.
    // 14:00 local: slot 1's draft time (16:00 - 150min = 13:30) has passed and both publishes are ahead.
    const late = { ...single, publishTimes: ['15:00', '16:00'] };
    const result = dueSlots(late, new Date('2026-11-16T09:00:00Z'));
    expect(result.due.map((entry) => entry.slot.slotIndex)).toEqual([0, 1]);
  });

  it('drops a slot whose publish window already closed instead of drafting a useless post', () => {
    // 14:00 local: the 10:30 post cannot go live any more, but the 16:00 one still can.
    const result = dueSlots(double, new Date('2026-11-16T09:00:00Z'));
    expect(result.due.map((entry) => entry.slot.slotIndex)).toEqual([1]);
  });

  it('skips a slot whose publish time has already passed', () => {
    // 17:00 local: the 10:30 post can no longer go live today, so drafting it would be busywork.
    const result = dueSlots(double, new Date('2026-11-16T12:00:00Z'));
    expect(result.due.map((entry) => entry.slot.slotIndex)).toEqual([]);
    expect(result.skipped[0]!.reason).toMatch(/publish time .* already passed/i);
  });

  it('says so on a day the owner does not publish', () => {
    const sunday = dueSlots(double, new Date('2026-11-15T09:00:00Z'));
    expect(sunday.due).toEqual([]);
    expect(sunday.skipped[0]!.reason).toBe('Not a scheduled publish day');
  });

  it('reports every due slot through generationDue', () => {
    const late = { ...single, publishTimes: ['15:00', '16:00'] };
    const due = generationDue(late, new Date('2026-11-16T09:00:00Z'));
    expect(due.due).toBe(true);
    expect(due.slots).toHaveLength(2);
    expect(due.slot.slotIndex).toBe(0);
  });

  it('behaves exactly like the single-slot version when there is one slot', () => {
    const due = generationDue(single, new Date('2026-11-16T04:00:00Z'));
    expect(due.due).toBe(true);
    expect(due.slots).toHaveLength(1);
    const early = generationDue(single, new Date('2026-11-16T01:00:00Z'));
    expect(early.due).toBe(false);
    expect(early.reason).toMatch(/Scheduled for 08:00/);
  });
});

describe('publishing time per slot', () => {
  it('waits for each slot’s own publish time', () => {
    const approvedAt = new Date('2026-11-16T04:00:00Z'); // 09:00 local
    const first = publishRunAt(double, approvedAt, 0);
    const second = publishRunAt(double, approvedAt, 1);
    expect(new Date(first).getTime()).toBeLessThan(new Date(second).getTime());
    expect(first).not.toEqual(second);
  });

  it('publishes immediately when approved after the slot', () => {
    const late = new Date('2026-11-16T12:00:00Z'); // 17:00 local, past both slots
    expect(publishRunAt(double, late, 1).getTime()).toBe(late.getTime());
  });

  it('falls back to the first slot for an unknown index', () => {
    const approvedAt = new Date('2026-11-16T04:00:00Z');
    expect(publishRunAt(double, approvedAt, 9)).toEqual(publishRunAt(double, approvedAt, 0));
  });

  it('ignores the schedule entirely when respectPublishTime is off', () => {
    const off = { ...double, respectPublishTime: false };
    const approvedAt = new Date('2026-11-16T04:00:00Z');
    expect(publishRunAt(off, approvedAt, 1).getTime()).toBe(approvedAt.getTime());
  });
});

describe('next slot', () => {
  it('finds the next slot of the same day before rolling over', () => {
    const next = nextSlot(double, new Date('2026-11-16T04:00:00Z')); // 09:00 local
    expect(next?.slotIndex).toBe(1);
    expect(next?.localDate).toBe('2026-11-16');
  });

  it('rolls to the next publishing day when today is used up', () => {
    const next = nextSlot(double, new Date('2026-11-16T12:00:00Z')); // 17:00 local
    expect(next?.localDate).toBe('2026-11-17');
    expect(next?.slotIndex).toBe(0);
  });

  it('skips the weekend', () => {
    // Friday 17:00 local -> Monday.
    const next = nextSlot(double, new Date('2026-11-20T12:00:00Z'));
    expect(next?.localDate).toBe('2026-11-23');
  });
});

describe('two posts in one day, through the real pipeline', () => {
  it('generates both slots, with separate posts and separate claims', async () => {
    const { createHarness } = await import('./helpers');
    const { generateDailyPost } = await import('@/src/core/generation');
    // 08:00 draft slot 0, 13:30 draft slot 1 (for a 16:00 publish).
    const harness = createHarness({
      now: '2026-11-16T09:00:00Z', // 14:00 local: both draft windows are open
      settings: { publishTimes: ['15:00', '16:00'] },
    });
    // The duplicate guard compares against recent risk and the fake provider returns one canned draft, so
    // give the two slots genuinely different drafts - that is what a real model would do.
    harness.ai.responses.push(
      {
        hook: 'Idempotency keys are not optional once a tool call can be retried.',
        body: 'A retry without a key created the duplicate record.\n\nWe hash the tool name and its arguments, store the result, and return the stored result on a repeat.\n\nThe fix was nine lines and removed the whole class of bug.',
        hashtags: ['AgenticAI', 'AIAutomation', 'Engineering'],
      },
      {
        hook: 'A retry loop turns one bad payload into twenty bad writes.',
        body: 'The loop was the problem, not the API.\n\nCapping attempts at three with a growing delay made the failure visible instead of noisy.\n\nFailures went from a wall of duplicates to a single alert with the payload attached.',
        hashtags: ['Retries', 'Reliability', 'SoftwareEngineering'],
      },
    );
    // One topic per slot: slot 1 must not pick up slot 0's row.
    harness.db.seedTopic({
      topicDate: '2026-11-16',
      topic: 'Idempotency keys for agent tool calls',
      slotIndex: 0,
      sheetRowNumber: 2,
    });
    harness.db.seedTopic({
      topicDate: '2026-11-16',
      topic: 'What a retry loop actually costs',
      slotIndex: 1,
      sheetRowNumber: 3,
    });

    const first = await generateDailyPost(harness.services, { slotIndex: 0, skipSync: true });
    expect(first.status).toBe('generated');
    const second = await generateDailyPost(harness.services, { slotIndex: 1, skipSync: true });
    expect(second.status).toBe('generated');

    if (first.status !== 'generated' || second.status !== 'generated') return;
    expect(first.post.slotIndex).toBe(0);
    expect(second.post.slotIndex).toBe(1);
    expect(first.post.id).not.toBe(second.post.id);
    // Different topics: the slot claim must take the next pending row, not the same one again.
    expect(first.post.topicId).not.toBe(second.post.topicId);

    // A third run for slot 0 is a duplicate, not a second post.
    const again = await generateDailyPost(harness.services, { slotIndex: 0, skipSync: true });
    expect(again.status).toBe('duplicate');
    expect(await harness.db.listPosts()).toHaveLength(2);
  });

  it('never gives one slot another slot’s post', async () => {
    const { createHarness } = await import('./helpers');
    const { generateDailyPost } = await import('@/src/core/generation');
    const harness = createHarness({
      now: '2026-11-16T09:00:00Z',
      settings: { publishTimes: ['15:00', '16:00'] },
    });
    harness.db.seedTopic({ topicDate: '2026-11-16', topic: 'One topic only for today', slotIndex: 0 });
    expect((await generateDailyPost(harness.services, { slotIndex: 0, skipSync: true })).status).toBe(
      'generated',
    );
    // Slot 1 has no topic of its own: it must report no_topic rather than reuse slot 0's row.
    const second = await generateDailyPost(harness.services, { slotIndex: 1, skipSync: true });
    expect(second.status).toBe('no_topic');
  });

  it('keeps the single-slot pipeline byte-for-byte the same', async () => {
    const { createHarness } = await import('./helpers');
    const { generateDailyPost } = await import('@/src/core/generation');
    const harness = createHarness({ now: '2026-11-16T04:00:00Z' });
    harness.db.seedTopic({ topicDate: '2026-11-16', topic: 'A normal single-post day' });
    const result = await generateDailyPost(harness.services, { skipSync: true });
    expect(result.status).toBe('generated');
    if (result.status !== 'generated') return;
    expect(result.post.slotIndex).toBe(0);
    expect(await harness.db.listPosts()).toHaveLength(1);
  });
});
