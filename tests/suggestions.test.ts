import { describe, expect, it } from 'vitest';
import {
  addIsoDays,
  findDuplicate,
  openPublishingDates,
  parseSuggestions,
  similarity,
  suggestTopics,
} from '@/src/core/suggestions';
import { defaultSettings } from '@/src/core/defaults';
import type { Topic } from '@/src/core/types';
import { createHarness } from './helpers';

const settings = { ...defaultSettings(), publishDays: [1, 2, 3, 4, 5] };

function topic(date: string, text: string, status: Topic['status'] = 'pending'): Topic {
  return {
    id: `t-${date}-${text.slice(0, 6)}`,
    sheetRowNumber: null,
    topicDate: date,
    slotIndex: 0,
    topic: text,
    contentType: 'insight',
    keyPoints: null,
    targetAudience: null,
    status,
    attempts: 0,
    lastError: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

describe('openPublishingDates', () => {
  it('only offers publishing days that are free', () => {
    // 2026-11-21 is a Saturday, 2026-11-22 a Sunday: neither is a publishing day.
    const dates = openPublishingDates(settings, {
      startDate: '2026-11-20', // Friday
      today: '2026-11-20',
      taken: new Set(['2026-11-23']),
      count: 4,
    });
    expect(dates).toEqual(['2026-11-20', '2026-11-24', '2026-11-25', '2026-11-26']);
  });

  it('never goes back before today even if the window starts earlier', () => {
    const dates = openPublishingDates(settings, {
      startDate: '2026-11-01',
      today: '2026-11-16',
      taken: new Set(),
      count: 2,
    });
    expect(dates).toEqual(['2026-11-16', '2026-11-17']);
  });

  it('walks past a fully booked week to the next free publishing days', () => {
    const taken = new Set(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    const dates = openPublishingDates(settings, {
      startDate: '2026-11-16',
      today: '2026-11-16',
      taken,
      count: 2,
    });
    expect(dates).toEqual(['2026-11-23', '2026-11-24']);
  });

  it('returns nothing when no weekday is a publishing day', () => {
    const dates = openPublishingDates(
      { ...settings, publishDays: [] },
      { startDate: '2026-11-16', today: '2026-11-16', taken: new Set(), count: 3 },
    );
    expect(dates).toEqual([]);
  });
});

describe('similarity and duplicate guard', () => {
  it('scores near-identical topics high and unrelated ones low', () => {
    const close = similarity(
      'Why every agent tool call needs an idempotency key',
      'Why every agent tool call needs an idempotency key!',
    );
    const far = similarity('Why every agent tool call needs a key', 'Designing a mobile approval flow');
    expect(close).toBeGreaterThan(0.95);
    expect(far).toBeLessThan(0.2);
  });

  it('finds the closest existing topic above the threshold', () => {
    const existing = [
      topic('2026-10-01', 'Designing a mobile approval flow for LinkedIn posts'),
      topic('2026-10-02', 'Idempotency keys for agent tool calls'),
    ];
    const found = findDuplicate('Idempotency keys for agent tool calls in production', existing);
    expect(found?.topic).toBe('Idempotency keys for agent tool calls');
    expect(findDuplicate('How I cut cold start time in half', existing)).toBeNull();
  });
});

describe('parseSuggestions', () => {
  const dates = ['2026-11-17', '2026-11-18'];

  it('assigns dates in order and keeps usable fields', () => {
    const text = JSON.stringify({
      suggestions: [
        {
          topic: 'Idempotency keys for agent tool calls',
          angle: 'Failure story',
          keyPoints: 'a\nb',
          audience: 'engineers',
          contentType: 'story',
        },
        {
          topic: 'Typed failures in agent workflows',
          angle: 'Short how-to',
          keyPoints: 'c',
          audience: 'engineers',
          contentType: 'how-to',
        },
      ],
    });
    const parsed = parseSuggestions(text, { count: 2, dates, existing: [], settings });
    expect(parsed.suggestions.map((item) => item.topicDate)).toEqual(dates);
    expect(parsed.suggestions[0]?.contentType).toBe('story');
    expect(parsed.suggestions[1]?.rationale).toBe('Short how-to');
  });

  it('drops duplicates instead of squeezing them into a slot', () => {
    const existing = [topic('2026-10-02', 'Idempotency keys for agent tool calls')];
    const text = JSON.stringify({
      suggestions: [
        { topic: 'Idempotency keys for agent tool calls', angle: 'Retry', keyPoints: '', audience: '' },
        { topic: 'Typed failures in agent workflows', angle: 'How-to', keyPoints: '', audience: '' },
      ],
    });
    const parsed = parseSuggestions(text, { count: 2, dates, existing, settings });
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0]?.topic).toBe('Typed failures in agent workflows');
    expect(parsed.skipped[0]?.reason).toContain('Too close');
  });

  it('refuses a reply that is not JSON', () => {
    expect(() => parseSuggestions('not json at all', { count: 1, dates, existing: [], settings })).toThrow(
      /not valid JSON/,
    );
  });

  it('falls back to "insight" for an unknown content type', () => {
    const text = JSON.stringify({
      suggestions: [{ topic: 'A real topic about queues', angle: 'x', keyPoints: '', audience: '', contentType: 'podcast' }],
    });
    const parsed = parseSuggestions(text, { count: 1, dates, existing: [], settings });
    expect(parsed.suggestions[0]?.contentType).toBe('insight');
  });

  it('never returns more suggestions than the open days', () => {
    const text = JSON.stringify({
      suggestions: [
        { topic: 'First distinct engineering topic', angle: 'a', keyPoints: '', audience: '' },
        { topic: 'Second completely different subject', angle: 'b', keyPoints: '', audience: '' },
        { topic: 'Third unrelated systems problem', angle: 'c', keyPoints: '', audience: '' },
      ],
    });
    const parsed = parseSuggestions(text, { count: 2, dates: ['2026-11-17'], existing: [], settings });
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.skipped.some((item) => item.reason.includes('No open publishing day'))).toBe(true);
  });
});

describe('suggestTopics (one AI request)', () => {
  it('asks the provider once and returns dated suggestions', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    let calls = 0;
    harness.ai.suggestTopics = async () => {
      calls += 1;
      return JSON.stringify({
        suggestions: [
          { topic: 'Idempotency keys for agent tool calls', angle: 'Failure story', keyPoints: 'x', audience: 'eng', contentType: 'story' },
          { topic: 'Typed failures in agent workflows', angle: 'How-to', keyPoints: 'y', audience: 'eng', contentType: 'how-to' },
        ],
      });
    };

    const result = await suggestTopics(
      { ai: harness.ai, clock: harness.clock, db: harness.db },
      { settings, existing: [], count: 2 },
    );

    expect(calls).toBe(1);
    expect(result.suggestions.map((item) => item.topicDate)).toEqual(['2026-11-17', '2026-11-18']);
    expect(result.provider).toBe('fake-ai');
  });

  it('fails loudly when the provider cannot plan topics', async () => {
    const harness = createHarness();
    const plain = { ...harness.ai, suggestTopics: undefined } as unknown as typeof harness.ai;
    await expect(
      suggestTopics({ ai: plain, clock: harness.clock, db: harness.db }, { settings, existing: [] }),
    ).rejects.toThrow(/cannot propose topics/);
  });

  it('reports when there is no publishing day to plan for, instead of inventing one', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    await expect(
      suggestTopics(
        { ai: harness.ai, clock: harness.clock, db: harness.db },
        { settings: { ...settings, publishDays: [] }, existing: [], count: 2 },
      ),
    ).rejects.toThrow(/No open publishing day/);
  });
});

describe('addIsoDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addIsoDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});
