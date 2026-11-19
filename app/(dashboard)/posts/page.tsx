'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import type { PostDto, SettingsDto } from '@/lib/types';
import {
  Alert,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Skeleton,
  IconGenerate,
  IconRefresh,
  IconSearch,
  IconSearchEmpty,
} from '@/ui';
import { StatusBadge } from '@/components/status-badge';
import { PostActions } from '@/components/post-actions';
import { VariantPicker } from '@/components/variant-picker';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'pending_approval', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'published', label: 'Published' },
  { value: 'failed', label: 'Failed' },
  { value: 'rejected', label: 'Rejected' },
] as const;

export default function PostsPage() {
  const [status, setStatus] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const statusParam = params.get('status');
    const queryParam = params.get('q');
    if (statusParam) setStatus(statusParam);
    if (queryParam) setQuery(queryParam);
  }, []);

  const { data, error, loading, reload, mutate } = useApi<{ posts: PostDto[] }>(
    `/content/posts?limit=100&variants=1${status ? `&status=${status}` : ''}`,
  );
  const settings = useApi<{ settings: SettingsDto }>('/settings');
  const timeZone = settings.data?.settings.ownerTimezone ?? 'UTC';
  const { busy, run } = useAction();
  const { toast } = useToast();

  const generateNow = () =>
    run(
      () => api.post<{ result: { status: string; reason?: string } }>('/content/generate', {}),
      (result) => {
        toast(
          `Generation: ${result.result.status}${result.result.reason ? ` — ${result.result.reason}` : ''}`,
          'success',
        );
        reload();
      },
      (message) => toast(message, 'error'),
    );

  const posts = React.useMemo(() => {
    const term = query.trim().toLowerCase();
    const all = (data?.posts ?? []).map((post) =>
      overrides[post.id] ? { ...post, status: overrides[post.id]! } : post,
    );
    if (!term) return all;
    return all.filter((post) =>
      `${post.hook} ${post.body} ${post.hashtags.join(' ')} ${post.runDate}`
        .toLowerCase()
        .includes(term),
    );
  }, [data, query, overrides]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <IconSearch
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search hook, body, hashtag or date"
            aria-label="Search posts"
            className="h-11 pl-9 sm:h-10"
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-11 flex-1 sm:h-9 sm:flex-none"
            loading={busy}
            onClick={generateNow}
          >
            <IconGenerate className="h-4 w-4" aria-hidden /> Generate now
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
            aria-label="Refresh posts"
            onClick={reload}
            loading={loading}
          >
            <IconRefresh className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="no-scrollbar -mx-3 overflow-x-auto px-3 sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6">
        <div className="flex w-max gap-1.5">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setStatus(filter.value)}
              className={cn(
                'h-11 shrink-0 whitespace-nowrap rounded-full border px-3.5 text-[12.5px] font-medium transition-colors sm:h-9',
                status === filter.value
                  ? 'border-transparent bg-primary text-primary-foreground shadow-sm'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <Alert tone="error" title="Could not load posts">
          {error}
        </Alert>
      ) : null}

      {loading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : null}

      {data && posts.length === 0 ? (
        <EmptyState
          icon={query ? <IconSearchEmpty aria-hidden /> : undefined}
          title={query ? 'No posts match your search' : 'No posts in this view'}
          description={
            query
              ? 'Try a different keyword, or clear the search to see every post.'
              : 'Add topics to your Google Sheet (or the Queue tab) and the scheduler will generate a post on the next publishing day.'
          }
          action={
            query ? (
              <Button size="sm" variant="outline" onClick={() => setQuery('')}>
                Clear search
              </Button>
            ) : undefined
          }
        />
      ) : null}

      <div className="space-y-2.5">
        {posts.map((post) => {
          const isExpanded = expanded[post.id] ?? false;
          return (
            <Card key={post.id}>
              <CardContent className="space-y-2.5 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="text-[11.5px] font-medium text-muted-foreground">
                      {post.runDate}
                    </p>
                    {post.editedByOwner ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        edited
                      </span>
                    ) : null}
                    {post.source === 'local-dev' ? (
                      <span className="rounded bg-warm/30 px-1.5 py-0.5 text-[10px] font-medium text-warning-foreground">
                        local-dev
                      </span>
                    ) : null}
                  </div>
                  <StatusBadge status={post.status} />
                </div>

                <p className="break-words text-[14px] font-medium leading-snug">{post.hook}</p>
                <div
                  className={cn(
                    'whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90',
                    !isExpanded && 'line-clamp-4',
                  )}
                >
                  {post.body}
                </div>
                {post.hashtags.length > 0 ? (
                  <p className="text-[12px] font-medium text-primary">{post.hashtags.join(' ')}</p>
                ) : null}

                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>
                    {post.charCount} chars · {post.model || post.provider}
                  </span>
                  <button
                    type="button"
                    className="-my-1 flex min-h-[44px] items-center px-1 font-medium text-primary"
                    onClick={() =>
                      setExpanded((current) => ({ ...current, [post.id]: !isExpanded }))
                    }
                  >
                    {isExpanded ? 'Show less' : 'Read full'}
                  </button>
                </div>

                {post.publishedUrl ? (
                  <a
                    href={post.publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-11 items-center truncate text-[12px] text-primary underline-offset-2 hover:underline sm:h-auto sm:block"
                  >
                    {post.publishedUrl}
                  </a>
                ) : null}

                {post.variants && post.variants.length > 1 ? (
                  <VariantPicker
                    post={post}
                    variants={post.variants}
                    onSelected={(updated) =>
                      mutate((current) =>
                        current
                          ? {
                              ...current,
                              posts: current.posts.map((item) =>
                                item.id === updated.id
                                  ? {
                                      ...updated,
                                      variants: (item.variants ?? []).map((variant) => ({
                                        ...variant,
                                        selected: variant.fullText === updated.fullText,
                                        discardedAt:
                                          variant.fullText === updated.fullText
                                            ? null
                                            : (variant.discardedAt ?? new Date().toISOString()),
                                      })),
                                    }
                                  : item,
                              ),
                            }
                          : current,
                      )
                    }
                  />
                ) : null}

                <PostActions
                  post={post}
                  onDone={reload}
                  onOptimistic={(status) =>
                    setOverrides((current) => ({ ...current, [post.id]: status }))
                  }
                />
                <p className="text-[10px] text-muted-foreground">
                  Created {new Date(post.createdAt).toLocaleString('en-GB')} · {timeZone}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
