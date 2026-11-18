'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { PostDto, PostVariantDto } from '@/lib/types';
import { Badge, Button, IconSuccess, cn } from '@/ui';
import { useToast } from '@/components/toast';

export interface VariantPickerProps {
  post: PostDto;
  variants: PostVariantDto[];
  onSelected?: (post: PostDto) => void;
}

/**
 * Side-by-side draft comparison. Mobile gets a horizontal snap row (one card at a time),
 * desktop shows all options in a grid. Selecting one rewrites the post, so the approval
 * link, the queue and the sheet keep pointing at the same post.
 */
export function VariantPicker({ post, variants, onSelected }: VariantPickerProps) {
  const { run, busy } = useAction();
  const { toast } = useToast();
  const [pending, setPending] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<PostVariantDto | null>(
    variants.find((variant) => variant.selected) ?? null,
  );

  React.useEffect(() => {
    setChosen(variants.find((variant) => variant.selected) ?? null);
  }, [variants]);

  if (variants.length < 2) return null;

  const locked = !['draft', 'pending_approval'].includes(post.status);
  const canSwitch = !locked && !post.editedByOwner;

  const choose = (variant: PostVariantDto) => {
    if (!canSwitch || variant.selected) return;
    setPending(variant.id);
    void run(
      () =>
        api.post<{ post: PostDto; variants: PostVariantDto[] }>(
          `/content/posts/${post.id}/variants/${variant.id}/select`,
          {},
        ),
      (result) => {
        setChosen(result.variants.find((item) => item.selected) ?? null);
        toast(`Using "${variant.angle}" for ${post.runDate}`, 'success');
        onSelected?.(result.post);
      },
      (message) => toast(message, 'error'),
    ).finally(() => setPending(null));
  };

  return (
    <section aria-label={`${variants.length} draft options`} className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11.5px] font-medium text-muted-foreground">
          {variants.length} drafts
          {chosen ? <span className="text-foreground"> · using “{chosen.angle}”</span> : null}
        </p>
        <p className="text-[10.5px] text-muted-foreground">
          {locked
            ? 'Locked after approval'
            : post.editedByOwner
              ? 'Edited by hand'
              : 'Tap to switch'}
        </p>
      </div>

      <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0">
        {variants.map((variant, index) => {
          const isChosen = chosen?.id === variant.id;
          const isBusy = busy && pending === variant.id;
          return (
            <div
              key={variant.id}
              className={cn(
                'flex min-w-[76%] snap-center flex-col gap-2 rounded-2xl border p-3 transition-colors sm:min-w-[52%] lg:min-w-0',
                isChosen
                  ? 'border-accent-strong/40 bg-accent/15'
                  : 'border-border bg-card hover:border-ink/20',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <Badge tone={isChosen ? 'green' : 'neutral'}>
                  {index + 1}. {variant.angle}
                </Badge>
                {isChosen ? (
                  <IconSuccess className="h-3.5 w-3.5 text-accent-strong" aria-hidden />
                ) : null}
              </div>

              <p className="line-clamp-3 text-[13px] font-medium leading-snug">{variant.hook}</p>
              <p className="line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/80">
                {variant.body}
              </p>

              <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                <span className="text-[10.5px] text-muted-foreground">
                  {variant.charCount} chars
                </span>
                {isChosen ? (
                  <span className="text-[11px] font-medium text-accent-strong">In use</span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => choose(variant)}
                    disabled={!canSwitch || busy}
                    aria-label={`Use ${variant.angle} for ${post.runDate}`}
                  >
                    {isBusy ? 'Switching…' : 'Use this'}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
