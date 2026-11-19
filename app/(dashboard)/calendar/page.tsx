'use client';

import * as React from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/hooks';
import type { CalendarDayDto, CalendarMonthDto } from '@/lib/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  IconCalendar,
  IconNextChevron,
  IconPosts,
  IconPrevious,
  PageHeader,
  Skeleton,
  CalendarGrid,
  CalendarLegend,
} from '@/ui';
import { SuggestionPanel } from '@/components/suggestion-panel';
import { StatusBadge } from '@/components/status-badge';

/** Phase 6 - the content calendar plus the "suggest next week" planner. */
export default function CalendarPage() {
  const [month, setMonth] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [showPlanner, setShowPlanner] = React.useState(false);

  // The first request has no month: the API answers with the owner's current month.
  const { data, error, loading, reload } = useApi<CalendarMonthDto>(
    month ? `/calendar?month=${month}` : '/calendar',
  );

  React.useEffect(() => {
    if (!month && data?.month) setMonth(data.month);
  }, [data, month]);

  const shift = (delta: number) => {
    if (!data) return;
    const [year, monthNumber] = data.month.split('-').map(Number);
    const index = (year ?? 2026) * 12 + ((monthNumber ?? 1) - 1) + delta;
    const nextYear = Math.floor(index / 12);
    const nextMonth = (index % 12) + 1;
    setSelected(null);
    setMonth(`${nextYear}-${String(nextMonth).padStart(2, '0')}`);
  };

  const days = data?.weeks.flat() ?? [];
  const selectedDay: CalendarDayDto | null = selected
    ? (days.find((day) => day.date === selected) ?? null)
    : null;

  return (
    <div className="space-y-3">
      <PageHeader
        title={data?.label ?? 'Calendar'}
        subtitle={
          data
            ? `Publishing days in ${data.timezone}. ${data.totals.openPublishingDays} open day(s) left to plan.`
            : 'What is planned, approved and published this month.'
        }
        actions={
          <>
            <Button
              size="icon"
              variant="outline"
              aria-label="Previous month"
              className="h-11 w-11"
              onClick={() => shift(-1)}
              disabled={!data}
            >
              <IconPrevious className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="outline"
              aria-label="Next month"
              className="h-11 w-11"
              onClick={() => shift(1)}
              disabled={!data}
            >
              <IconNextChevron className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              className="h-11 sm:h-9"
              onClick={() => setShowPlanner((value) => !value)}
            >
              <IconCalendar className="h-4 w-4" aria-hidden />
              {showPlanner ? 'Hide planner' : 'Plan next week'}
            </Button>
          </>
        }
      />

      {error ? (
        <Alert tone="error" title="Could not load the calendar">
          {error}
        </Alert>
      ) : null}

      {loading && !data ? (
        <Skeleton className="h-[420px] w-full" />
      ) : null}

      {showPlanner ? <SuggestionPanel onAdded={reload} /> : null}

      {data ? (
        <Card>
          <CardHeader className="gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{data.label}</CardTitle>
              <CalendarLegend totals={data.totals} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <CalendarGrid
              weeks={data.weeks}
              monthKey={data.month}
              selectedDate={selected}
              onSelect={(day) => setSelected((current) => (current === day.date ? null : day.date))}
            />

            {selectedDay ? (
              <div className="rounded-2xl border border-white/70 bg-white/55 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-semibold">{selectedDay.date}</p>
                  {selectedDay.status ? <StatusBadge status={selectedDay.status} /> : null}
                  {selectedDay.isPublishingDay ? (
                    <Badge tone="green">Publishing day</Badge>
                  ) : (
                    <Badge tone="neutral">Not a publishing day</Badge>
                  )}
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/85">
                  {selectedDay.title || 'Nothing planned for this day yet.'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedDay.postId ? (
                    <Link href={`/posts/?q=${selectedDay.date}`}>
                      <Button size="sm" variant="outline" className="h-11 sm:h-9">
                        <IconPosts className="h-4 w-4" aria-hidden /> Open post
                      </Button>
                    </Link>
                  ) : (
                    <Link href="/queue/">
                      <Button size="sm" variant="outline" className="h-11 sm:h-9">
                        Add a topic for this day
                      </Button>
                    </Link>
                  )}
                  {selectedDay.publishedUrl ? (
                    <a href={selectedDay.publishedUrl} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="ghost" className="h-11 sm:h-9">
                        View on LinkedIn
                      </Button>
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}

            {data.gaps.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-warm/60 bg-warm/25 px-3 py-2">
                <p className="text-[12px] text-foreground">
                  <span className="font-semibold">{data.gaps.length} publishing day(s)</span> in the
                  next three weeks have no topic.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 sm:h-9"
                  onClick={() => setShowPlanner(true)}
                >
                  Plan them now
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {data && days.every((day) => day.kind === 'open') ? (
        <EmptyState
          icon={<IconCalendar aria-hidden />}
          title="Nothing planned this month"
          description="Add topics in the Content queue, or let the planner propose a week for you."
          action={
            <Button size="sm" onClick={() => setShowPlanner(true)}>
              Suggest topics
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
