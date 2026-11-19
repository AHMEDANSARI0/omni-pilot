import type { ISODate, Settings, Topic } from './types';
import type { Post } from './types';
import { addIsoDays } from './suggestions';
import { isPublishDay } from './schedule';

/**
 * Phase 6 - the content calendar.
 *
 * Pure date maths over data the dashboard already has (topics + posts). No new table, no new
 * query: the calendar is a view, and a view that needs its own storage would drift from the
 * queue within a day.
 */

export type CalendarEntryKind = 'published' | 'scheduled' | 'failed' | 'pending' | 'open';

export interface CalendarEntry {
  date: ISODate;
  /** Sunday-first weekday index, 0 = Sunday. */
  weekday: number;
  isPublishingDay: boolean;
  isToday: boolean;
  isPast: boolean;
  kind: CalendarEntryKind;
  postId: string | null;
  topicId: string | null;
  title: string;
  status: string | null;
  publishedUrl: string | null;
}

export interface CalendarMonth {
  /** First day shown in the grid (may belong to the previous month). */
  startDate: ISODate;
  /** Last day shown in the grid. */
  endDate: ISODate;
  label: string;
  weeks: CalendarEntry[][];
  /** First and last day of the month itself. */
  monthStart: ISODate;
  monthEnd: ISODate;
}

/** The 7 dates of the week that contains `date`, Sunday first. */
export function weekStart(date: ISODate): ISODate {
  const parsed = new Date(`${date}T00:00:00Z`);
  return addIsoDays(date, -parsed.getUTCDay());
}

/** 1 = January. */
export function monthOf(date: ISODate): number {
  return Number(date.slice(5, 7));
}

export function yearOf(date: ISODate): number {
  return Number(date.slice(0, 4));
}

export function monthStartOf(year: number, month: number): ISODate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${monthStartOf(year, month)}T00:00:00Z`),
  );
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

const PUBLISHED_STATUSES = new Set(['published']);
const FAILED_STATUSES = new Set(['failed', 'rejected', 'expired']);

interface EntrySource {
  date: ISODate;
  settings: Settings;
  today: ISODate;
  topics: Topic[];
  posts: Post[];
}

function entryFor({ date, settings, today, topics, posts }: EntrySource): CalendarEntry {
  const parsed = new Date(`${date}T00:00:00Z`);
  const post = posts.find((candidate) => candidate.runDate === date) ?? null;
  const topic = post
    ? topics.find((candidate) => candidate.id === post.topicId) ?? null
    : (topics.find((candidate) => candidate.topicDate === date) ?? null);

  const base = {
    date,
    weekday: parsed.getUTCDay(),
    isPublishingDay: isPublishDay(settings, date),
    isToday: date === today,
    isPast: date < today,
    postId: post?.id ?? null,
    topicId: topic?.id ?? null,
    publishedUrl: post?.publishedUrl ?? null,
  };

  if (post) {
    const kind: CalendarEntryKind = PUBLISHED_STATUSES.has(post.status)
      ? 'published'
      : FAILED_STATUSES.has(post.status)
        ? 'failed'
        : post.status === 'approved' || post.status === 'publishing'
          ? 'scheduled'
          : 'pending';
    return {
      ...base,
      kind,
      title: topic?.topic ?? post.hook,
      status: post.status,
    };
  }

  if (topic) {
    return {
      ...base,
      kind: 'pending',
      title: topic.topic,
      status: topic.status,
    };
  }

  return { ...base, kind: 'open', title: '', status: null };
}

/**
 * Builds one month grid (Sunday first, 6 rows max) with every day already resolved to its
 * entry, so the UI renders without any date maths of its own.
 */
export function buildMonth(options: {
  year: number;
  month: number;
  settings: Settings;
  today: ISODate;
  topics: Topic[];
  posts: Post[];
}): CalendarMonth {
  const monthStart = monthStartOf(options.year, options.month);
  const monthEnd = addIsoDays(monthStartOf(options.year, options.month + 1), -1);
  const gridStart = weekStart(monthStart);
  const gridEnd = addIsoDays(weekStart(monthEnd), 6);

  const weeks: CalendarEntry[][] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    const week: CalendarEntry[] = [];
    for (let day = 0; day < 7; day += 1) {
      week.push(
        entryFor({
          date: cursor,
          settings: options.settings,
          today: options.today,
          topics: options.topics,
          posts: options.posts,
        }),
      );
      cursor = addIsoDays(cursor, 1);
    }
    weeks.push(week);
  }

  return {
    startDate: gridStart,
    endDate: gridEnd,
    label: monthLabel(options.year, options.month),
    weeks,
    monthStart,
    monthEnd,
  };
}

/** Totals for the month strip above the grid. */
export function monthTotals(month: CalendarMonth): {
  published: number;
  scheduled: number;
  failed: number;
  pending: number;
  openPublishingDays: number;
} {
  const entries = month.weeks
    .flat()
    .filter((entry) => entry.date >= month.monthStart && entry.date <= month.monthEnd);
  return {
    published: entries.filter((entry) => entry.kind === 'published').length,
    scheduled: entries.filter((entry) => entry.kind === 'scheduled').length,
    failed: entries.filter((entry) => entry.kind === 'failed').length,
    pending: entries.filter((entry) => entry.kind === 'pending').length,
    openPublishingDays: entries.filter(
      (entry) => entry.isPublishingDay && entry.kind === 'open' && !entry.isPast,
    ).length,
  };
}

/**
 * Upcoming days that still need a topic - what "suggest next week" should fill. A publishing
 * day with no topic and no post counts as a gap.
 */
export function upcomingGaps(options: {
  settings: Settings;
  today: ISODate;
  topics: Topic[];
  posts: Post[];
  days?: number;
}): ISODate[] {
  const horizon = options.days ?? 14;
  const gaps: ISODate[] = [];
  const taken = new Set<string>([
    ...options.topics.map((topic) => topic.topicDate),
    ...options.posts.map((post) => post.runDate),
  ]);
  for (let step = 0; step <= horizon; step += 1) {
    const date = addIsoDays(options.today, step);
    if (isPublishDay(options.settings, date) && !taken.has(date)) gaps.push(date);
  }
  return gaps;
}
