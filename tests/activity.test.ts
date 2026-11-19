import { describe, expect, it } from 'vitest';
import { ACTIVITY_DAYS, approvalLag, approvalReplyHours, buildActivity } from '@/src/core/activity';
import type { Approval, Post } from '@/src/core/types';

function approval(patch: Partial<Approval>): Approval {
  return {
    id: 'a1',
    postId: 'p1',
    status: 'approved',
    emailSentAt: '2026-11-10T06:00:00.000Z',
    usedAt: '2026-11-10T12:00:00.000Z',
    ...patch,
  } as Approval;
}

function post(patch: Partial<Post>): Post {
  return {
    id: 'p1',
    runDate: '2026-11-10',
    status: 'published',
    publishedAt: null,
    ...patch,
  } as Post;
}

describe('Phase 6 - dashboard activity', () => {
  it('always returns one bucket per day, ending on the anchor date', () => {
    const series = buildActivity([], '2026-11-18', 7);
    expect(series).toHaveLength(7);
    expect(series[0]!.date).toBe('2026-11-12');
    expect(series[6]!.date).toBe('2026-11-18');
    expect(series.every((point) => point.generated === 0 && point.failed === 0)).toBe(true);
  });

  it('counts a draft on its run date and a publish on the publish date', () => {
    const series = buildActivity(
      [
        post({ runDate: '2026-11-16', publishedAt: '2026-11-17T05:30:00.000Z' }),
        post({ id: 'p2', runDate: '2026-11-16', status: 'failed' }),
      ],
      '2026-11-18',
      7,
    );
    const day16 = series.find((point) => point.date === '2026-11-16')!;
    const day17 = series.find((point) => point.date === '2026-11-17')!;
    expect(day16).toMatchObject({ generated: 2, failed: 1, published: 0 });
    expect(day17).toMatchObject({ published: 1, generated: 0 });
  });

  it('ignores rows outside the window instead of stretching the chart', () => {
    const series = buildActivity([post({ runDate: '2026-01-01' })], '2026-11-18', 7);
    expect(series).toHaveLength(7);
    expect(series.reduce((total, point) => total + point.generated, 0)).toBe(0);
  });

  it('defaults to the 90-day window the API uses', () => {
    expect(buildActivity([], '2026-11-18')).toHaveLength(ACTIVITY_DAYS);
  });

  it('measures reply time only on approvals that were emailed and decided', () => {
    const hours = approvalReplyHours([
      approval({ id: 'a1', emailSentAt: '2026-11-10T06:00:00.000Z', usedAt: '2026-11-10T12:00:00.000Z' }),
      approval({ id: 'a2', usedAt: null }),
      approval({ id: 'a3', emailSentAt: null }),
      // a decision "before" the email is a data error, not a negative reply time
      approval({ id: 'a4', emailSentAt: '2026-11-11T06:00:00.000Z', usedAt: '2026-11-10T06:00:00.000Z' }),
    ]);
    expect(hours).toEqual([6]);
  });

  it('reports a median and the sample it came from', () => {
    const lag = approvalLag([
      approval({ id: 'a1', emailSentAt: '2026-11-10T06:00:00.000Z', usedAt: '2026-11-10T08:00:00.000Z' }),
      approval({ id: 'a2', emailSentAt: '2026-11-10T06:00:00.000Z', usedAt: '2026-11-10T18:00:00.000Z' }),
      approval({ id: 'a3', emailSentAt: '2026-11-10T06:00:00.000Z', usedAt: '2026-11-11T18:00:00.000Z' }),
    ]);
    expect(lag).toEqual({ medianHours: 12, sample: 3 });
  });

  it('says "nothing measured" when there is no decision yet', () => {
    expect(approvalLag([approval({ usedAt: null })])).toEqual({ medianHours: null, sample: 0 });
  });
});
