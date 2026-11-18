'use client';

import Link from 'next/link';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  IconAi,
  IconLinkedin,
  IconMail,
  IconNext,
  IconPosts,
  IconQueue,
  IconSheets,
  IconSuccess,
  IconTrendDown,
  IconTrendUp,
  IconTile,
  type IconComponent,
} from '@/ui';
import { StatusBadge } from './status-badge';
import { formatDateTime, relativeTime, truncate } from '@/lib/utils';
import type { PostDto } from '@/lib/types';

type StatTone = 'indigo' | 'amber' | 'green' | 'red' | 'blue';

const VALUE_TONES: Record<StatTone, string> = {
  indigo: 'text-foreground',
  amber: 'text-warning-foreground',
  green: 'text-success-foreground',
  red: 'text-danger-foreground',
  blue: 'text-info-foreground',
};

export function StatCard({
  label,
  value,
  icon,
  tone = 'indigo',
  href,
  trend,
  hint,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  tone?: StatTone;
  href?: string;
  trend?: { current: number; previous: number };
  hint?: string;
}) {
  const delta = trend
    ? trend.previous === 0
      ? trend.current === 0
        ? 0
        : 100
      : Math.round(((trend.current - trend.previous) / trend.previous) * 100)
    : null;
  const positive = (delta ?? 0) >= 0;

  const body = (
    <Card className="h-full transition-shadow duration-150 hover:shadow-pop">
      <CardContent className="p-4 lg:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              {label}
            </p>
            <p
              className={`mt-2 text-[26px] font-semibold leading-none tabular ${VALUE_TONES[tone]}`}
            >
              {value}
            </p>
          </div>
          <IconTile tone={tone}>{icon}</IconTile>
        </div>

        <div className="mt-3 flex items-center gap-1.5 text-[11.5px]">
          {delta !== null ? (
            <span
              className={`inline-flex items-center gap-1 font-medium ${
                positive ? 'text-success-foreground' : 'text-danger-foreground'
              }`}
            >
              {positive ? (
                <IconTrendUp className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <IconTrendDown className="h-3.5 w-3.5" aria-hidden />
              )}
              {positive ? '+' : ''}
              {delta}%
            </span>
          ) : null}
          <span className="truncate text-muted-foreground">{hint}</span>
        </div>
      </CardContent>
    </Card>
  );

  return href ? (
    <Link href={href} className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring/60">
      {body}
    </Link>
  ) : (
    body
  );
}

const INTEGRATION_ICONS: Record<string, { icon: IconComponent; tone: StatTone }> = {
  sheets: { icon: IconSheets, tone: 'green' },
  linkedin: { icon: IconLinkedin, tone: 'blue' },
  email: { icon: IconMail, tone: 'amber' },
  ai: { icon: IconAi, tone: 'indigo' },
};

export function IntegrationRow({
  name,
  detail,
  status,
  href,
  kind = 'sheets',
}: {
  name: string;
  detail: string;
  status: string;
  href?: string;
  kind?: keyof typeof INTEGRATION_ICONS;
}) {
  const { icon: Icon, tone } = INTEGRATION_ICONS[kind] ?? INTEGRATION_ICONS.sheets!;
  const content = (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-canvas/70 lg:px-5">
      <IconTile tone={tone} size="md">
        <Icon aria-hidden />
      </IconTile>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{name}</p>
        <p className="truncate text-[11.5px] text-muted-foreground">{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <StatusBadge status={status} />
        {href ? <IconNext className="h-4 w-4 text-muted-foreground/60" aria-hidden /> : null}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}

export function ScheduleCard({
  nextRunAt,
  timeZone,
  dueNow,
  reason,
  lastRunAt,
  lastRunStatus,
  action,
}: {
  nextRunAt: string | null;
  timeZone: string;
  dueNow: boolean;
  reason: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  action?: React.ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Next run</CardTitle>
        <IconTile tone="indigo" size="sm">
          <IconQueue aria-hidden />
        </IconTile>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3">
        <div>
          <p className="text-[17px] font-semibold leading-tight">
            {nextRunAt ? formatDateTime(nextRunAt, timeZone) : 'No upcoming slot'}
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            {timeZone} · {dueNow ? 'Generation window is open now' : reason}
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg bg-canvas px-2.5 py-2">
            <IconSuccess className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <p className="truncate text-[11.5px] text-muted-foreground">
              Last run:{' '}
              <span className="font-medium text-foreground">
                {lastRunAt ? relativeTime(lastRunAt) : 'never'}
              </span>
              {lastRunStatus ? ` · ${lastRunStatus}` : ''}
            </p>
          </div>
          {action}
        </div>
      </CardContent>
    </Card>
  );
}

export function PostPreviewCard({ post, timeZone }: { post: PostDto; timeZone: string }) {
  return (
    <Link
      href="/posts/"
      className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Card className="transition-shadow duration-150 hover:shadow-pop">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
              <IconPosts className="h-3.5 w-3.5" aria-hidden />
              {post.runDate}
            </span>
            <StatusBadge status={post.status} />
          </div>

          <p className="mt-2 line-clamp-2 text-[13.5px] font-medium leading-snug text-foreground">
            {truncate(post.hook, 150)}
          </p>
          <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
            {truncate(post.fullText, 200)}
          </p>

          <div className="mt-2.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {post.charCount} chars · {post.hashtags.length} hashtags
            </span>
            <span title={formatDateTime(post.createdAt, timeZone)}>
              {relativeTime(post.createdAt)}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
