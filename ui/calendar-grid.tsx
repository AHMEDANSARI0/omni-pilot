'use client';

import * as React from 'react';
import { cn } from './cn';

/**
 * Month grid for the content calendar.
 *
 * Presentation only: every day arrives already resolved by the API (`kind`, `title`,
 * `isPublishingDay`), so this file contains no date maths and no colours - the state colours
 * live in `ui/tokens.css` via the `data-kind` selectors below.
 *
 * Mobile: one week per row would be unusable at 320 px, so the grid stays 7 columns but drops
 * the titles (dots only) and each day is still a >=44px tap target.
 */

export type CalendarEntryKind = 'published' | 'scheduled' | 'failed' | 'pending' | 'open';

export interface CalendarDay {
  date: string;
  weekday: number;
  isPublishingDay: boolean;
  isToday: boolean;
  isPast: boolean;
  kind: CalendarEntryKind;
  title: string;
  postId: string | null;
  topicId: string | null;
  publishedUrl: string | null;
  status: string | null;
}

export const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const WEEKDAY_LABELS_WIDE = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function CalendarGrid({
  weeks,
  monthKey,
  onSelect,
  selectedDate,
}: {
  weeks: CalendarDay[][];
  /** "2026-11" - days outside this month are dimmed. */
  monthKey: string;
  onSelect?: (day: CalendarDay) => void;
  selectedDate?: string | null;
}) {
  return (
    <div className="min-w-0">
      <div className="grid grid-cols-7 gap-1 pb-1">
        {WEEKDAY_LABELS.map((label, index) => (
          <div
            key={`${label}-${index}`}
            aria-hidden
            className="text-center text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/80"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {weeks.flat().map((day) => {
          const inMonth = day.date.startsWith(monthKey);
          const selected = selectedDate === day.date;
          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onSelect?.(day)}
              aria-label={`${day.date}${day.title ? `: ${day.title}` : ''}`}
              aria-current={day.isToday ? 'date' : undefined}
              data-kind={day.kind}
              data-day={day.date}
              className={cn(
                'group relative flex min-h-[64px] min-w-0 flex-col items-stretch gap-1 rounded-2xl border p-1.5 text-left transition-colors sm:min-h-[86px] sm:p-2',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                inMonth ? 'border-white/70 bg-white/45' : 'border-transparent bg-white/20',
                day.isPublishingDay ? 'day-publishing' : '',
                selected ? 'ring-2 ring-accent-strong/40' : '',
              )}
            >
              <span className="flex items-center justify-between gap-1">
                <span
                  className={cn(
                    'tabular text-[11.5px] font-semibold',
                    day.isToday ? 'today-pill' : inMonth ? 'text-foreground' : 'text-muted-foreground/60',
                  )}
                >
                  {Number(day.date.slice(8, 10))}
                </span>
                <span aria-hidden className="day-dot" />
              </span>

              {/* Title only where there is room; phones get the dot + aria-label instead. */}
              <span className="hidden min-w-0 text-[10.5px] leading-tight text-muted-foreground sm:line-clamp-2 sm:block">
                {day.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Legend + month totals, so the colours are always explained, never guessed. */
export function CalendarLegend({
  totals,
}: {
  totals: { published: number; scheduled: number; failed: number; pending: number; openPublishingDays: number };
}) {
  const items: Array<{ kind: CalendarEntryKind | 'publishing'; label: string; count?: number }> = [
    { kind: 'published', label: 'Published', count: totals.published },
    { kind: 'scheduled', label: 'Approved', count: totals.scheduled },
    { kind: 'pending', label: 'Waiting', count: totals.pending },
    { kind: 'failed', label: 'Failed', count: totals.failed },
    { kind: 'open', label: 'Open days', count: totals.openPublishingDays },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-muted-foreground">
      {items.map((item) => (
        <li key={item.kind} className="flex items-center gap-1.5">
          <span aria-hidden data-kind={item.kind} className="day-dot" />
          <span>
            {item.label}
            {typeof item.count === 'number' ? (
              <span className="ml-1 tabular font-semibold text-foreground">{item.count}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
