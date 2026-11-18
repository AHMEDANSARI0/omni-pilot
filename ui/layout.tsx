'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from './cn';
import {
  IconAdd,
  IconApprove,
  IconBrand,
  IconNotifications,
  IconSearch,
  IconSignOut,
  type IconComponent,
} from './icons';
import { Badge, Button, IconButton } from './primitives';

/**
 * Presentational shell. It knows nothing about data, auth or the API - the app
 * passes finished values in. Restyle the whole frame from here.
 */

export interface ShellNavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: IconComponent;
  title: string;
  subtitle: string;
  badge?: number;
}

export function isActivePath(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

function NavList({ items, pathname }: { items: ShellNavItem[]; pathname: string }) {
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const active = isActivePath(pathname, item.href);
        const Glyph = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group flex h-10 items-center gap-3 rounded-full px-3 text-[13px] font-medium transition-all',
                active
                  ? 'bg-white text-foreground shadow-[0_6px_16px_-10px_rgba(23,32,45,0.55)]'
                  : 'text-muted-foreground hover:bg-white/60 hover:text-foreground',
              )}
            >
              <Glyph
                className={cn('h-[17px] w-[17px] shrink-0', active ? 'text-ink' : 'text-ink/55')}
                aria-hidden
              />
              <span className="truncate">{item.label}</span>
              {item.badge ? (
                <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[10px] font-semibold text-white">
                  {item.badge > 9 ? '9+' : item.badge}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Sidebar({
  nav,
  pathname,
  brand,
  status,
  user,
  cta,
  onSearch,
  onSignOut,
}: {
  nav: ShellNavItem[];
  pathname: string;
  brand: { name: string; tagline: string };
  status?: { tone: 'live' | 'local'; title: string; description: string };
  user?: { name: string; caption: string; initials: string; canSignOut: boolean };
  cta?: { href: string; label: string };
  onSearch?: (term: string) => void;
  onSignOut?: () => void;
}) {
  const [term, setTerm] = React.useState('');

  return (
    <aside className="glass-strong sticky top-3 hidden h-[calc(100dvh-1.5rem)] w-[258px] shrink-0 flex-col rounded-[28px] p-3 lg:flex">
      <Link href="/" className="flex items-center gap-2.5 rounded-2xl px-1.5 py-1.5">
        <span className="mesh-orb flex h-10 w-10 items-center justify-center rounded-2xl border border-white/70 shadow-sm">
          <IconBrand className="h-[18px] w-[18px] text-ink" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14.5px] font-semibold leading-none tracking-tight">
            {brand.name}
          </span>
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">
            {brand.tagline}
          </span>
        </span>
      </Link>

      <form
        className="px-1 pb-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch?.(term.trim());
        }}
      >
        <div className="relative">
          <IconSearch
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search…"
            aria-label="Search posts"
            className="h-10 w-full rounded-full border border-white/70 bg-white/60 pl-9 pr-3 text-[16px] text-foreground backdrop-blur-md transition-colors placeholder:text-muted-foreground/80 focus-visible:border-accent/70 focus-visible:bg-white/85 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/20 sm:text-[13px]"
          />
        </div>
      </form>

      <nav aria-label="Workspace" className="no-scrollbar flex-1 overflow-y-auto px-1">
        <p className="px-2 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
          Workspace
        </p>
        <NavList items={nav} pathname={pathname} />
      </nav>

      <div className="mt-2 space-y-2">
        {cta ? (
          <Link
            href={cta.href}
            className="ink-pill flex h-10 items-center justify-center gap-2 rounded-full text-[12.5px] font-semibold transition-transform active:scale-[0.99]"
          >
            <IconApprove className="h-4 w-4" aria-hidden />
            {cta.label}
          </Link>
        ) : null}

        {status ? (
          <div className="rounded-2xl border border-white/70 bg-white/45 p-3 backdrop-blur-sm">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  status.tone === 'live' ? 'bg-accent-strong' : 'bg-warm-strong',
                )}
              />
              <p className="text-[11.5px] font-semibold text-foreground">{status.title}</p>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {status.description}
            </p>
          </div>
        ) : null}

        {user ? (
          <div className="flex items-center gap-2 rounded-2xl px-1 py-0.5">
            <span className="mesh-orb flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/70 text-[11px] font-semibold text-ink">
              {user.initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium">{user.name}</p>
              <p className="truncate text-[10.5px] text-muted-foreground">{user.caption}</p>
            </div>
            {user.canSignOut ? (
              <IconButton label="Sign out" onClick={onSignOut} className="h-8 w-8">
                <IconSignOut className="h-4 w-4" aria-hidden />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function Topbar({
  title,
  subtitle,
  actions,
  pending,
  live,
  dev,
  initials,
}: {
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
  pending: number;
  live: boolean;
  dev: boolean;
  initials: string;
}) {
  return (
    <header className="glass sticky top-2 z-30 rounded-[26px] px-3 py-2.5 sm:px-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="mesh-orb flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-white/70 lg:hidden">
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

        <div className="flex shrink-0 items-center gap-1.5 lg:gap-2">
          <Badge tone={live ? 'green' : 'amber'} className="hidden sm:inline-flex">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {live ? 'Live' : 'Local'}
          </Badge>
          {dev ? (
            <Badge tone="amber" className="hidden sm:inline-flex">
              Dev
            </Badge>
          ) : null}

          {actions}

          <Link href="/queue/?new=1" className="hidden sm:block">
            <Button size="sm" className="gap-1.5">
              <IconAdd className="h-4 w-4" aria-hidden />
              New topic
            </Button>
          </Link>

          <Link
            href="/approvals/"
            aria-label={pending > 0 ? `${pending} posts awaiting approval` : 'No pending approvals'}
            className="relative flex h-10 w-10 items-center justify-center rounded-full border border-white/70 bg-white/55 text-ink/70 backdrop-blur-md transition-colors hover:bg-white/85 hover:text-ink"
          >
            <IconNotifications className="h-[17px] w-[17px]" aria-hidden />
            {pending > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9.5px] font-semibold text-white">
                {pending > 9 ? '9+' : pending}
              </span>
            ) : null}
          </Link>

          <Link
            href="/settings/?tab=account"
            aria-label="Account settings"
            className="mesh-orb flex h-10 w-10 items-center justify-center rounded-full border border-white/70 text-[11px] font-semibold text-ink"
          >
            {initials}
          </Link>
        </div>
      </div>
    </header>
  );
}

function MobileTabBar({ nav, pathname }: { nav: ShellNavItem[]; pathname: string }) {
  return (
    <nav aria-label="Primary" className="safe-bottom fixed inset-x-2 bottom-2 z-40 lg:hidden">
      <div className="glass-strong grid grid-cols-6 gap-0.5 rounded-[26px] px-1.5 py-1.5">
        {nav.map((item) => {
          const active = isActivePath(pathname, item.href);
          const Glyph = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl px-0.5 text-[10px] font-medium transition-colors"
            >
              <span
                className={cn(
                  'flex h-7 w-10 items-center justify-center rounded-full transition-colors',
                  active ? 'bg-ink text-white' : 'text-ink/55',
                )}
              >
                <Glyph className={cn('h-[19px] w-[19px]', active && 'stroke-[2.2]')} aria-hidden />
              </span>
              <span className={cn('truncate', active ? 'text-ink' : 'text-muted-foreground')}>
                {item.shortLabel}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function Shell({
  nav,
  pathname,
  brand,
  title,
  subtitle,
  pending,
  live,
  dev,
  initials,
  user,
  status,
  cta,
  banner,
  topbarActions,
  onSearch,
  onSignOut,
  children,
}: {
  nav: ShellNavItem[];
  pathname: string;
  brand: { name: string; tagline: string };
  title: string;
  subtitle: string;
  pending: number;
  live: boolean;
  dev: boolean;
  initials: string;
  user?: { name: string; caption: string; initials: string; canSignOut: boolean };
  status?: { tone: 'live' | 'local'; title: string; description: string };
  cta?: { href: string; label: string };
  banner?: React.ReactNode;
  topbarActions?: React.ReactNode;
  onSearch?: (term: string) => void;
  onSignOut?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen p-2 sm:p-3">
      <div className="mx-auto flex w-full max-w-[1400px] gap-3 lg:gap-4">
        <Sidebar
          nav={nav}
          pathname={pathname}
          brand={brand}
          status={status}
          user={user}
          cta={cta}
          onSearch={onSearch}
          onSignOut={onSignOut}
        />
        <div className="min-w-0 flex-1">
          <Topbar
            title={title}
            subtitle={subtitle}
            actions={topbarActions}
            pending={pending}
            live={live}
            dev={dev}
            initials={initials}
          />
          {banner}
          <main className="mx-auto w-full max-w-[1180px] px-0.5 py-3 pb-28 sm:py-4 lg:pb-10">
            {children}
          </main>
        </div>
      </div>
      <MobileTabBar nav={nav} pathname={pathname} />
    </div>
  );
}
