import { describe, expect, it } from 'vitest';
import { checkDraft } from '@/src/core/duplicate';

/**
 * Phase 10: two posts in one day are written back to back, and the second draft is compared against the
 * first one - same day, different slot. That comparison rejected slot 1 every time ("Repeats earlier work:
 * The body repeats the post from <today>"), so the second publish time could never produce a draft.
 *
 * Found by `npm run e2e` on the second run of the phase 10 spec; the slot-topic bug hid it the first time.
 * The rule: the row this draft will become is not "earlier work". Everything else still is.
 */
describe('checkDraft - the post being replaced is not earlier work', () => {
  const sameDay = [
    {
      hook: 'Slot one: the retry loop that taught us about idempotency',
      body: 'Retries without an idempotency key duplicate side effects. That was the bug that cost us a day.',
      runDate: '2034-02-01',
      slotIndex: 0,
    },
  ];

  it('ignores the same day and slot, so slot 1 can be written', () => {
    const check = checkDraft(
      { hook: sameDay[0]!.hook, body: sameDay[0]!.body },
      sameDay,
      { ignore: { runDate: '2034-02-01', slotIndex: 0 } },
    );
    expect(check.duplicate).toBe(false);
  });

  it('does not reject the other slot of the same day - those two are siblings by design', () => {
    // Generating twice in one day is the Phase 10 feature, not a mistake. Slot 1 is written while slot 0's
    // post is already in the database, and comparing them rejected it every time with
    // "The body repeats the post from <today>" - so the second publish time could never produce a post.
    const check = checkDraft(
      { hook: sameDay[0]!.hook, body: sameDay[0]!.body },
      sameDay,
      { ignore: { runDate: '2034-02-01', slotIndex: 1 } },
    );
    expect(check.duplicate).toBe(false);
  });

  it('still rejects a repeat of the same day when no slot is being written for', () => {
    // The check is only relaxed for a run that names its own (day, slot). Used on its own - the topic idea
    // guard, a probe - a same-day match is still a match.
    const check = checkDraft({ hook: sameDay[0]!.hook, body: sameDay[0]!.body }, sameDay);
    expect(check.duplicate).toBe(true);
  });

  it('still catches a repeat from another day in the same slot', () => {
    const check = checkDraft(
      { hook: sameDay[0]!.hook, body: sameDay[0]!.body },
      sameDay,
      { ignore: { runDate: '2034-02-02', slotIndex: 0 } },
    );
    expect(check.duplicate).toBe(true);
  });
});
