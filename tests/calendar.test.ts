import { describe, expect, it } from 'vitest';
import {
  buildMonth,
  monthTotals,
  shiftMonth,
  upcomingGaps,
  weekStart,
  daysInMonth,
  monthLabel,
} from '@/src/core/calendar';
import { defaultSettings } from '@/src/core/defaults';
import type { Post, Topic } from '@/src/core/types';

const settings = { ...defaultSettings(), publishDays: [1, 2, 3, 4, 5] };

function topic(date: string, text: string, status: Topic['status'] = 'pending'): Topic {
  return {
    id: `t-${date}`,
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
    createdAt: '',
    updatedAt: '',
  };
}

function post(runDate: string, status: Post['status'], extra: Partial<Post> = {}): Post {
  return {
    id: `p-${runDate}`,
    topicId: `t-${runDate}`,
    runDate,
    slotIndex: 0,
    hook: `Hook for ${runDate}`,
    body: 'Body',
    hashtags: [],
    fullText: 'Body',
    charCount: 4,
    provider: 'fake',
    model: 'fake',
    status,
    source: 'generated',
    editedByOwner: false,
    errorMessage: null,
    externalId: null,
    publishedUrl: null,
    publishedAt: null,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

const base = {
  year: 2026,
  month: 11,
  settings,
  today: '2026-11-18',
  topics: [] as Topic[],
  posts: [] as Post[],
};

describe('calendar grid', () => {
  it('starts on a Sunday and covers the whole month', () => {
    const month = buildMonth(base);
    expect(month.startDate).toBe('2026-11-01'); // Sunday
    expect(month.monthStart).toBe('2026-11-01');
    expect(month.monthEnd).toBe('2026-11-30');
    expect(month.endDate).toBe('2026-12-05'); // trailing days of the last week
    for (const week of month.weeks) expect(week).toHaveLength(7);
  });

  it('marks publishing days, today and the past', () => {
    const month = buildMonth(base);
    const days = month.weeks.flat();
    const saturday = days.find((entry) => entry.date === '2026-11-21')!;
    const monday = days.find((entry) => entry.date === '2026-11-16')!;
    const today = days.find((entry) => entry.date === '2026-11-18')!;
    expect(saturday.isPublishingDay).toBe(false);
    expect(monday.isPublishingDay).toBe(true);
    expect(today.isToday).toBe(true);
    expect(monday.isPast).toBe(true);
    expect(monday.date < '2026-11-18').toBe(true);
  });

  it('resolves a published post, a scheduled one and a failure', () => {
    const month = buildMonth({
      ...base,
      topics: [topic('2026-11-03', 'Idempotency keys'), topic('2026-11-04', 'Typed failures'), topic('2026-11-05', 'Queue design')],
      posts: [
        post('2026-11-03', 'published', { publishedUrl: 'https://linkedin.com/x' }),
        post('2026-11-04', 'approved'),
        post('2026-11-05', 'failed'),
      ],
    });
    const days = month.weeks.flat();
    expect(days.find((entry) => entry.date === '2026-11-03')).toMatchObject({
      kind: 'published',
      title: 'Idempotency keys',
      publishedUrl: 'https://linkedin.com/x',
    });
    expect(days.find((entry) => entry.date === '2026-11-04')?.kind).toBe('scheduled');
    expect(days.find((entry) => entry.date === '2026-11-05')?.kind).toBe('failed');
  });

  it('shows a topic without a post as pending, and an empty publishing day as open', () => {
    const month = buildMonth({
      ...base,
      topics: [topic('2026-11-20', 'Planned but not generated')],
    });
    const days = month.weeks.flat();
    expect(days.find((entry) => entry.date === '2026-11-20')).toMatchObject({
      kind: 'pending',
      title: 'Planned but not generated',
      status: 'pending',
    });
    expect(days.find((entry) => entry.date === '2026-11-19')?.kind).toBe('open');
  });

  it('counts the month totals and the open days left to fill', () => {
    const month = buildMonth({
      ...base,
      topics: [topic('2026-11-17', 'A'), topic('2026-11-25', 'B')],
      posts: [post('2026-11-17', 'published'), post('2026-11-18', 'pending_approval')],
    });
    const totals = monthTotals(month);
    expect(totals.published).toBe(1);
    expect(totals.pending).toBe(2); // 18th (post) + 25th (topic only)
    expect(totals.openPublishingDays).toBeGreaterThan(0);
  });

  it('handles a month that starts on a Sunday without a leading week', () => {
    const month = buildMonth({ ...base, year: 2026, month: 2 });
    expect(month.startDate).toBe('2026-02-01');
    expect(month.monthEnd).toBe('2026-02-28');
  });
});

describe('date helpers', () => {
  it('knows week starts, month lengths and labels', () => {
    expect(weekStart('2026-11-18')).toBe('2026-11-15');
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(monthLabel(2026, 11)).toBe('November 2026');
  });

  it('shifts months across year boundaries', () => {
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });
});

describe('upcomingGaps', () => {
  it('lists publishing days with no topic and no post, starting today', () => {
    const gaps = upcomingGaps({
      settings,
      today: '2026-11-20', // Friday
      topics: [topic('2026-11-23', 'Already planned')],
      posts: [],
      days: 4,
    });
    // 20th free, 21/22 weekend, 23rd planned, 24th free
    expect(gaps).toEqual(['2026-11-20', '2026-11-24']);
  });
});
