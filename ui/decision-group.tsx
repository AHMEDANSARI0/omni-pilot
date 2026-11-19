/**
 * Split button for the approvals page: "Approve" is the primary action, "Reject" is one
 * tap away but visually quieter. Both keep a 44 px hit area on touch screens.
 *
 * Lives in the design system (not the page) so the shape and colours stay replaceable.
 */
'use client';

import * as React from 'react';
import { cn } from './cn';
import { buttonVariants } from './primitives';

export function DecisionGroup({
  onApprove,
  onReject,
  busy = false,
  disabled = false,
  className,
  approveLabel = 'Approve',
  rejectLabel = 'Reject',
}: {
  onApprove: () => void;
  onReject: () => void;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  approveLabel?: string;
  rejectLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Approval decision"
      className={cn(
        'inline-flex w-full items-stretch overflow-hidden rounded-full border border-white/70 bg-white/55 backdrop-blur-md sm:w-auto',
        className,
      )}
    >
      <button
        type="button"
        onClick={onApprove}
        disabled={disabled || busy}
        className={cn(
          buttonVariants({ variant: 'success', size: 'sm' }),
          'h-11 flex-1 rounded-none px-5 text-[13.5px] sm:flex-none',
        )}
      >
        {busy ? 'Working…' : approveLabel}
      </button>
      <span aria-hidden className="w-px shrink-0 self-stretch bg-ink/10" />
      <button
        type="button"
        onClick={onReject}
        disabled={disabled || busy}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'h-11 flex-1 rounded-none px-4 text-[13px] text-muted-foreground hover:text-destructive sm:flex-none',
        )}
      >
        {rejectLabel}
      </button>
    </div>
  );
}
