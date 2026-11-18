'use client';

import Link from 'next/link';
import { Bell, Plus, Zap } from 'lucide-react';
import type { AuthMode } from '@/lib/session';
import { cn } from '@/lib/utils';
import { buttonVariants } from '../ui/button';
import { initialsFrom, pageMeta } from './nav';

export function Topbar({
  pathname,
  mode,
  pendingApprovals,
}: {
  pathname: string;
  mode: AuthMode | null;
  pendingApprovals: number;
}) {
  const meta = pageMeta(pathname);
  const badge = pendingApprovals > 9 ? '9+' : String(pendingApprovals);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/85 backdrop-blur-md">
      <div className="flex h-16 items-center justify-between gap-3 px-4 lg:px-8">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground lg:hidden">
            <Zap className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[15.5px] font-semibold leading-tight tracking-tight lg:text-[18px]">
              {meta.title}
            </h1>
            <p className="hidden truncate text-[12px] text-muted-foreground sm:block">
              {meta.subtitle}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 lg:gap-2.5">
          <span
            className={cn(
              'hidden items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium sm:inline-flex',
              mode?.servicesMode === 'live'
                ? 'bg-success-soft text-success-foreground'
                : 'bg-violet-50 text-violet-700',
            )}
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {mode?.servicesMode === 'live' ? 'Live' : 'Local'}
          </span>

          {mode?.devBypass ? (
            <span className="hidden items-center rounded-md bg-warning-soft px-2 py-1 text-[11px] font-medium text-warning-foreground sm:inline-flex">
              Dev
            </span>
          ) : null}

          <Link
            href="/queue/?new=1"
            className={cn(buttonVariants({ size: 'sm' }), 'h-9 gap-1.5 rounded-lg px-2.5 sm:px-3')}
          >
            <Plus className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">New topic</span>
          </Link>

          <Link
            href="/approvals/"
            aria-label={
              pendingApprovals > 0
                ? `${pendingApprovals} posts awaiting approval`
                : 'No pending approvals'
            }
            className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Bell className="h-[17px] w-[17px]" aria-hidden />
            {pendingApprovals > 0 ? (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9.5px] font-semibold text-white">
                {badge}
              </span>
            ) : null}
          </Link>

          <Link
            href="/settings/?tab=account"
            aria-label="Account settings"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[11px] font-semibold text-white shadow-sm"
          >
            {initialsFrom(mode?.ownerEmailHint)}
          </Link>
        </div>
      </div>
    </header>
  );
}
