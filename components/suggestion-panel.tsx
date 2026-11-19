'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { SuggestionResultDto, TopicDto } from '@/lib/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  IconAi,
  IconRefresh,
  Skeleton,
  cn,
} from '@/ui';
import { useToast } from '@/components/toast';

/**
 * "Suggest next week": one AI request, a review list, and an explicit accept.
 *
 * Rules this UI keeps:
 *   - nothing is stored until the owner presses "Add to queue"
 *   - dates already taken are shown as unavailable, never silently skipped
 *   - a failed request shows the provider's message verbatim (no fake success)
 */
export function SuggestionPanel({ onAdded }: { onAdded?: () => void }) {
  const { run, busy } = useAction();
  const { toast } = useToast();
  const [result, setResult] = React.useState<SuggestionResultDto | null>(null);
  const [excluded, setExcluded] = React.useState<Record<string, boolean>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [added, setAdded] = React.useState<number | null>(null);

  const generate = () =>
    run(
      () => api.post<SuggestionResultDto>('/content/suggestions', { count: 5 }),
      (data) => {
        setResult(data);
        setExcluded({});
        setAdded(null);
        setError(null);
        toast(
          `${data.suggestions.length} idea(s) for ${data.windowStart} → ${data.windowEnd}`,
          'success',
        );
      },
      (message) => {
        // Keep the failure on screen: it is the only honest signal the owner gets.
        setError(message);
        setResult(null);
      },
    );

  const kept = (result?.suggestions ?? []).filter((item) => !excluded[item.topicDate]);

  const accept = () =>
    run(
      () =>
        api.post<{ added: number; skipped: Array<{ topic: string; reason: string }> }>(
          '/content/suggestions/accept',
          {
            topics: kept.map((item) => ({
              topicDate: item.topicDate,
              topic: item.topic,
              contentType: item.contentType,
              keyPoints: item.keyPoints || null,
              targetAudience: item.targetAudience || null,
            })),
          },
        ),
      (data) => {
        setAdded(data.added);
        setResult(null);
        toast(
          data.added > 0 ? `${data.added} topic(s) added to the queue` : 'Nothing was added',
          data.added > 0 ? 'success' : 'info',
        );
        if (data.skipped.length > 0) {
          toast(data.skipped[0]!.reason, 'error');
        }
        onAdded?.();
      },
      (message) => toast(message, 'error'),
    );

  return (
    <Card id="planner" data-testid="planner">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <IconAi className="h-4 w-4 text-accent-strong" aria-hidden />
            Suggest next week
          </CardTitle>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            One AI request proposes topics for your open publishing days. Nothing is saved until
            you add it.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-11 shrink-0 sm:h-9"
          loading={busy}
          onClick={generate}
        >
          <IconRefresh className="h-4 w-4" aria-hidden />
          {result ? 'Again' : 'Suggest'}
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        {error ? (
          <Alert tone="error" title="Could not get suggestions">
            {error}
          </Alert>
        ) : null}

        {busy && !result ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}

        {added !== null && added > 0 ? (
          <Alert tone="success" title="Added to the queue">
            {added} topic(s) are now in the Content queue. Open the queue to edit or reorder them.
          </Alert>
        ) : null}

        {result && result.suggestions.length > 0 ? (
          <>
            <ul className="space-y-2">
              {result.suggestions.map((item) => {
                const isExcluded = Boolean(excluded[item.topicDate]);
                return (
                  <li
                    key={`${item.topicDate}-${item.topic}`}
                    className={cn(
                      'rounded-2xl border p-3 transition-colors',
                      isExcluded
                        ? 'border-border/60 bg-white/25 opacity-60'
                        : 'border-white/70 bg-white/55',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{item.topicDate}</Badge>
                      {item.rationale ? <Badge tone="violet">{item.rationale}</Badge> : null}
                      <label className="ml-auto flex min-h-[44px] cursor-pointer items-center gap-2 text-[11.5px] text-muted-foreground">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border"
                          checked={!isExcluded}
                          onChange={(event) =>
                            setExcluded((current) => ({
                              ...current,
                              [item.topicDate]: !event.target.checked,
                            }))
                          }
                        />
                        Keep
                      </label>
                    </div>
                    <p className="mt-1 text-[13px] font-medium leading-snug">{item.topic}</p>
                    {item.keyPoints ? (
                      <p className="mt-1 whitespace-pre-line text-[12px] leading-relaxed text-muted-foreground">
                        {item.keyPoints}
                      </p>
                    ) : null}
                    {item.targetAudience ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        For {item.targetAudience}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {result.skipped.length > 0 ? (
              <Alert tone="warning" title={`${result.skipped.length} suggestion(s) dropped`}>
                {result.skipped.map((item) => (
                  <span key={item.topic} className="block">
                    {item.reason}
                  </span>
                ))}
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11.5px] text-muted-foreground">
                {kept.length} of {result.suggestions.length} selected · {result.provider}/
                {result.model}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" className="h-11 sm:h-9" onClick={() => setResult(null)}>
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="h-11 sm:h-9"
                  loading={busy}
                  disabled={kept.length === 0}
                  onClick={accept}
                >
                  Add {kept.length} to queue
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
