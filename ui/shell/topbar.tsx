'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '../cn';
import { IconAdd, IconBrand, IconNotifications } from '../icons';
import { Badge, Button } from '../primitives';

/**
 * The page header. Sticky, glass, and never wider than the reading column it sits over
 * (the shell provides the column, so the topbar cannot drift away from the content).
 */
export function Topbar({
  title,
  subtitle,
  actions,
  pending,
  live,
  dev,
  initials,
  onOpenMenu,
}: {
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
  pending: number;
  live: boolean;
  dev: boolean;
  initials: string;
  /** Mobile only: opens the navigation drawer. */
  onOpenMenu?: () => void;
}) {
  return (
    <header className="glass sticky top-0 z-30 rounded-b-panel px-3 py-2 sm:px-4 lg:top-0 lg:rounded-b-none">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* < lg the sidebar is a drawer, so the menu button lives here. */}
          <button
            type="button"
            onClick={onOpenMenu}
            data-shell="menu-button"
            aria-label="Open navigation menu"
            aria-haspopup="dialog"
            aria-expanded={false}
            aria-controls="shell-drawer"
            className="mr-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink/70 transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:hidden"
          >
            <span aria-hidden className="flex w-[18px] flex-col gap-[4px]">
              <span className="h-[1.5px] w-full rounded-full bg-current" />
              <span className="h-[1.5px] w-full rounded-full bg-current" />
              <span className="h-[1.5px] w-full rounded-full bg-current" />
            </span>
          </button>

          <span className="mesh-orb hidden h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-white/70 sm:flex lg:hidden">
            <IconBrand className="h-4 w-4 text-ink" aria-hidden />
          </span>

          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight lg:text-[17px]">
              {title}
            </h1>
            <p className="hidden truncate text-[11.5px] text-muted-foreground sm:block">
              {subtitle}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5 lg:gap-2">
          <Badge tone={live ? 'green' : 'amber'} className="hidden sm:inline-flex">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {live ? 'Live' : 'Local'}
          </Badge>
          {dev ? (
            <Badge tone="amber" className="hidden md:inline-flex">
              Dev
            </Badge>
          ) : null}

          {actions}

          <Link href="/queue/" className="hidden md:block" aria-label="Add a new topic">
            <Button size="sm" className="gap-1.5">
              <IconAdd className="h-4 w-4" aria-hidden />
              New topic
            </Button>
          </Link>

          <Link
            href="/approvals/"
            aria-label={pending > 0 ? `${pending} posts awaiting approval` : 'No pending approvals'}
            className="relative flex h-11 w-11 items-center justify-center rounded-full border border-white/70 bg-white/55 text-ink/70 backdrop-blur-md transition-colors hover:bg-white/85 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <IconNotifications className="h-[17px] w-[17px]" aria-hidden />
            {pending > 0 ? (
              <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9.5px] font-semibold text-destructive-foreground">
                {pending > 9 ? '9+' : pending}
              </span>
            ) : null}
          </Link>

          <Link
            href="/settings/?tab=account"
            aria-label="Account settings"
            className="mesh-orb flex h-11 w-11 items-center justify-center rounded-full border border-white/70 text-[11px] font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {initials}
          </Link>
        </div>
      </div>
    </header>
  );
}

/** Bottom thumb navigation - phones and small tablets only. */
export function MobileTabBar({
  nav,
  pathname,
}: {
  nav: {
    href: string;
    shortLabel: string;
    icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  }[];
  pathname: string;
}) {
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <nav aria-label="Primary" className="safe-bottom fixed inset-x-2 bottom-2 z-40 lg:hidden">
      <div
        className={cn(
          'glass-strong grid gap-0.5 rounded-panel px-1.5 py-1.5',
          nav.length > 5 ? 'grid-cols-6' : 'grid-cols-5',
        )}
      >
        {nav.slice(0, 6).map((item) => {
          const active = isActive(item.href);
          const Glyph = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="flex min-h-[52px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl px-0.5 text-[10px] font-medium transition-colors"
            >
              <span
                className={cn(
                  'flex h-7 w-10 max-w-full items-center justify-center rounded-full transition-colors',
                  active ? 'bg-ink text-ink-foreground' : 'text-ink/55',
                )}
              >
                <Glyph className={cn('h-[19px] w-[19px]', active && 'stroke-[2.2]')} aria-hidden />
              </span>
              <span
                className={cn(
                  'w-full truncate text-center',
                  active ? 'text-ink' : 'text-muted-foreground',
                )}
              >
                {item.shortLabel}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
