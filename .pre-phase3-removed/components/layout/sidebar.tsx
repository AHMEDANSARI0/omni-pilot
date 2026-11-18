'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogOut, Search, Zap } from 'lucide-react';
import { signOut } from '@/lib/api';
import type { AuthMode } from '@/lib/session';
import { cn } from '@/lib/utils';
import { NAV, initialsFrom, isActive } from './nav';

export function Sidebar({ pathname, mode }: { pathname: string; mode: AuthMode | null }) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');

  const search = (event: React.FormEvent) => {
    event.preventDefault();
    const term = query.trim();
    router.push(term ? `/posts/?q=${encodeURIComponent(term)}` : '/posts/');
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-border bg-card lg:flex">
      <Link href="/" className="flex h-16 items-center gap-2.5 px-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Zap className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14.5px] font-semibold leading-none tracking-tight">
            PostPilot
          </span>
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">
            LinkedIn automation
          </span>
        </span>
      </Link>

      <form onSubmit={search} className="px-3 pb-1">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search posts…"
            aria-label="Search posts"
            className="h-9 w-full rounded-lg border border-border bg-canvas pl-8 pr-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10"
          />
        </div>
      </form>

      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        <p className="px-2 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
          Workspace
        </p>
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
                    active
                      ? 'bg-primary-soft text-accent-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4 shrink-0',
                      active ? 'text-primary' : 'text-muted-foreground',
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="space-y-2 border-t border-border p-3">
        <div className="rounded-xl border border-border bg-canvas p-3">
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                mode?.servicesMode === 'live' ? 'bg-success' : 'bg-violet-500',
              )}
            />
            <p className="text-[11.5px] font-semibold text-foreground">
              {mode?.servicesMode === 'live' ? 'Live services' : 'Local stubs'}
            </p>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {mode?.servicesMode === 'live'
              ? 'Gemini, Sheets, Resend and LinkedIn are connected.'
              : 'Nothing is really sent or published in this mode.'}
          </p>
        </div>

        <div className="flex items-center gap-2 px-1">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[11px] font-semibold text-white">
            {initialsFrom(mode?.ownerEmailHint)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium">{mode?.ownerEmailHint || 'Owner'}</p>
            <p className="truncate text-[10.5px] text-muted-foreground">
              {mode?.devBypass ? 'Dev bypass' : 'Signed in'}
            </p>
          </div>
          {mode?.requiresAuth && !mode?.devBypass ? (
            <button
              type="button"
              aria-label="Sign out"
              onClick={() => {
                signOut();
                router.replace('/signin/');
              }}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LogOut className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
