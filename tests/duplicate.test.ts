import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_THRESHOLD,
  HOOK_THRESHOLD,
  checkDraft,
  closest,
  similarity,
  trigrams,
  withinWindow,
  words,
} from '@/src/core/duplicate';

const recent = [
  {
    hook: 'Most agent workflows fail on the boring part: idempotency keys.',
    body: 'Retries without an idempotency key duplicate side effects. That was the bug that cost us a day.',
    runDate: '2026-11-10',
  },
  {
    hook: 'I deleted 400 lines of retry logic and the pipeline got faster.',
    body: 'The retries were hiding a cold start problem, not fixing it.',
    runDate: '2026-11-05',
  },
];

describe('Phase 7 - duplicate protection', () => {
  it('normalises words: case, punctuation, plurals', () => {
    expect(words('Retries, Keys & IDs!')).toEqual(['retry', 'key', 'id']);
  });

  it('builds word trigrams, not character trigrams', () => {
    // "human in the loop approval agent" -> 4 words after stop-word removal -> 2 trigrams
    expect(trigrams('human in the loop approval agent').size).toBe(2);
    expect(trigrams('too short').size).toBe(0);
  });

  it('scores the same idea high and a different idea low', () => {
    const same = similarity(
      'Most agent workflows fail on the boring part: idempotency keys.',
      'Agent workflows fail on the boring part - idempotency keys.',
    );
    const different = similarity(
      'Most agent workflows fail on the boring part: idempotency keys.',
      'How I cut cold start time in half with a queue',
    );
    expect(same).toBeGreaterThan(0.8);
    expect(different).toBeLessThan(0.2);
  });

  it('returns the closest match and its score, or null', () => {
    const match = closest('Most agent workflows fail on the boring part - idempotency keys.', recent, (p) => p.hook);
    expect(match?.item.runDate).toBe('2026-11-10');
    expect(match?.score).toBeGreaterThanOrEqual(0.55);
    expect(closest('Designing a mobile approval flow', recent, (p) => p.hook)).toBeNull();
  });

  it('respects a custom threshold', () => {
    const text = 'Most agent workflows fail on the boring part';
    expect(closest(text, recent, (p) => p.hook, 0.99)).toBeNull();
    expect(closest(text, recent, (p) => p.hook, 0.1)).not.toBeNull();
  });

  it('flags a draft whose hook repeats a recent post', () => {
    const check = checkDraft(
      {
        hook: 'Most agent workflows fail on the boring part: idempotency keys.',
        body: 'Completely different body about queues and backpressure.',
      },
      recent,
    );
    expect(check.duplicate).toBe(true);
    expect(check.matchOf).toContain('idempotency');
    expect(check.reason).toContain('2026-11-10');
  });

  it('flags a repeated body even when the hook is fresh', () => {
    const check = checkDraft(
      {
        hook: 'A brand new opening nobody has read before.',
        body: 'Retries without an idempotency key duplicate side effects. That was the bug that cost us a day.',
      },
      recent,
    );
    expect(check.duplicate).toBe(true);
    expect(check.reason).toContain('body');
  });

  it('lets a genuinely new draft through', () => {
    const check = checkDraft(
      {
        hook: 'Our approval email went to spam for three days before anyone noticed.',
        body: 'The fix was a plain-text alternative and a shorter subject. Nothing clever.',
      },
      recent,
    );
    expect(check).toEqual({ duplicate: false, matchOf: null, score: 0, reason: null });
  });

  it('keeps the thresholds in a sane order', () => {
    expect(HOOK_THRESHOLD).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    expect(DUPLICATE_THRESHOLD).toBeGreaterThan(0);
    expect(DUPLICATE_THRESHOLD).toBeLessThan(1);
  });

  it('only looks inside the 180-day window', () => {
    const rows = [
      { date: '2026-11-16', id: 'fresh' },
      { date: '2026-01-05', id: 'old' },
      { date: null, id: 'undated' },
    ];
    const kept = withinWindow(rows, 180, (row) => row.date, '2026-11-18');
    expect(kept.map((row) => row.id)).toEqual(['fresh']);
  });

  it('treats a zero-day window as "nothing to compare"', () => {
    expect(withinWindow(recent, 0, (post) => post.runDate, '2026-11-18')).toEqual([]);
  });
});
