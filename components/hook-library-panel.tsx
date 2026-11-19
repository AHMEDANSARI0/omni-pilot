'use client';

/**
 * Hook library (Phase 7).
 *
 * Presentation only: the outcome buckets, pattern counts and the prompt block all arrive resolved
 * from `GET /content/hooks`. This file never decides whether a hook "worked" - it draws what the API
 * measured.
 *
 * The prompt block is shown on purpose. The owner should be able to read the exact text the model was
 * given, not a friendly paraphrase of it.
 */

import * as React from 'react';
import type { HookLibraryDto, HookRecordDto } from '@/lib/types';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  cn,
} from '@/ui';

type Bucket = 'proven' | 'waiting' | 'rejected';

const BUCKETS: Array<{
  key: Bucket;
  label: string;
  tone: 'success' | 'neutral' | 'error';
  blurb: string;
}> = [
  {
    key: 'proven',
    label: 'Proven',
    tone: 'success',
    blurb: 'The post went live, so the opening earned its place.',
  },
  {
    key: 'waiting',
    label: 'Waiting',
    tone: 'neutral',
    blurb: 'Approved or pending - not evidence either way yet.',
  },
  {
    key: 'rejected',
    label: 'Rejected',
    tone: 'error',
    blurb: 'Kept as a warning: the next prompt is told not to repeat the shape.',
  },
];

function HookRow({ record }: { record: HookRecordDto }) {
  return (
    <li className="rounded-2xl border border-white/70 bg-white/55 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="violet">{record.pattern}</Badge>
        <span className="text-[11px] text-muted-foreground">{record.runDate}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug">{record.hook}</p>
    </li>
  );
}

function BucketList({
  bucket,
  records,
}: {
  bucket: (typeof BUCKETS)[number];
  records: HookRecordDto[];
}) {
  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            {bucket.label}
            <span className="text-[12px] font-normal text-muted-foreground">{records.length}</span>
          </CardTitle>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{bucket.blurb}</p>
        </div>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-white/80 bg-white/40 p-3 text-[12.5px] text-muted-foreground">
            Nothing here yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {records.map((record) => (
              <HookRow key={`${record.runDate}-${record.hook}`} record={record} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function HookLibraryPanel({
  data,
  loading,
  error,
}: {
  data: HookLibraryDto | null;
  loading: boolean;
  error: string | null;
}) {
  const [showPrompt, setShowPrompt] = React.useState(false);

  if (error) {
    return (
      <Alert tone="error" title="Could not load the hook library">
        {error}
      </Alert>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-3 lg:space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between lg:p-5">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">{data.summary}</p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Measured from {data.windowStart} to {data.windowEnd}. A hook counts as proven only when
              its post actually published — no model opinion, no invented numbers.
            </p>
          </div>
          {data.patterns.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {data.patterns.map((pattern) => (
                <li key={pattern.pattern}>
                  <Badge tone="neutral">
                    {pattern.pattern} · {pattern.count}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-3 lg:gap-4">
        {BUCKETS.map((bucket) => (
          <BucketList key={bucket.key} bucket={bucket} records={data[bucket.key]} />
        ))}
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>What the model is told</CardTitle>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              The exact block added to the generation prompt. Empty until there is something real to
              say.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowPrompt((open) => !open)}
            className="flex min-h-[44px] shrink-0 items-center rounded-full border border-border px-3 text-[12px] font-medium sm:min-h-0 sm:py-1.5"
          >
            {showPrompt ? 'Hide' : 'Show'}
          </button>
        </CardHeader>
        <CardContent>
          {data.promptBlock ? (
            <pre
              className={cn(
                'overflow-x-auto rounded-2xl border border-white/70 bg-white/55 p-3 text-[11.5px] leading-relaxed',
                !showPrompt && 'max-h-[92px] overflow-hidden',
              )}
            >
              {data.promptBlock}
            </pre>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              Nothing yet — the prompt has no hook section until at least one post publishes or gets
              rejected.
            </p>
          )}
        </CardContent>
      </Card>

      <p className="px-1 text-[11.5px] text-muted-foreground">
        Duplicate protection runs at {Math.round(data.threshold * 100)}% similarity over the last six
        months, on both new topics and generated drafts.
      </p>
    </div>
  );
}
