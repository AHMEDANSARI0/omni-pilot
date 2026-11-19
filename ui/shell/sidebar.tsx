'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '../cn';
import { IconApprove, IconBrand, IconSearch, IconSignOut, type IconComponent } from '../icons';
import { IconButton } from '../primitives';

/**
 * The workspace rail.
 *
 * Desktop (lg+): pinned to the viewport's left edge, full height, and collapsible
 * from 264 px down to a 72 px icon rail. The state is a prop (`collapsed`) so this
 * file stays presentational; the shell owns the choice and the storage.
 *
 * The width itself comes from CSS (var(--sidebar-w)), which also drives the shell's
 * grid, so the content column and the rail can never disagree.
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

export function NavList({
  items,
  pathname,
  collapsed = false,
  onNavigate,
  idPrefix = 'side',
}: {
  items: ShellNavItem[];
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
  idPrefix?: string;
}) {
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const active = isActivePath(pathname, item.href);
        const Glyph = item.icon;
        const tooltipId = `${idPrefix}-tip-${item.href.replace(/\W+/g, '')}`;
        return (
          <li key={item.href} className="relative">
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              aria-describedby={collapsed ? tooltipId : undefined}
              className={cn(
                'group relative flex items-center rounded-full text-[13px] font-medium transition-colors',
                collapsed ? 'h-10 w-10 justify-center' : 'h-10 gap-3 px-3',
                active
                  ? 'bg-white text-foreground shadow-pill'
                  : 'text-muted-foreground hover:bg-white/60 hover:text-foreground',
              )}
            >
              {/* active indicator bar - collapsed rail keeps it so the icon still reads as "here" */}
              <span
                aria-hidden
                className={cn(
                  'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-strong transition-opacity',
                  active ? 'opacity-100' : 'opacity-0',
                )}
              />
              <Glyph
                className={cn('h-[17px] w-[17px] shrink-0', active ? 'text-ink' : 'text-ink/55')}
                aria-hidden
              />
              {collapsed ? null : (
                <>
                  <span className="truncate">{item.label}</span>
                  {item.badge ? (
                    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[10px] font-semibold text-ink-foreground">
                      {item.badge > 9 ? '9+' : item.badge}
                    </span>
                  ) : null}
                </>
              )}

              {/* Badge dot in the rail, plus a CSS-only tooltip on hover/focus. */}
              {collapsed && item.badge ? (
                <span
                  aria-hidden
                  className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[9px] font-semibold text-ink-foreground"
                >
                  {item.badge > 9 ? '9+' : item.badge}
                </span>
              ) : null}
              {collapsed ? (
                <span id={tooltipId} role="tooltip" className="rail-tooltip">
                  {item.label}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export interface SidebarProps {
  nav: ShellNavItem[];
  pathname: string;
  brand: { name: string; tagline: string };
  collapsed: boolean;
  onToggle: () => void;
  status?: { tone: 'live' | 'local'; title: string; description: string };
  user?: { name: string; caption: string; initials: string; canSignOut: boolean };
  cta?: { href: string; label: string };
  onSearch?: (term: string) => void;
  onSignOut?: () => void;
  /** Drawer mode: rendered inside the mobile sheet, so it never renders the collapse toggle. */
  variant?: 'rail' | 'drawer';
  onNavigate?: () => void;
}

export function Sidebar({
  nav,
  pathname,
  brand,
  collapsed,
  onToggle,
  status,
  user,
  cta,
  onSearch,
  onSignOut,
  variant = 'rail',
  onNavigate,
}: SidebarProps) {
  const [term, setTerm] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const expandFocusPending = React.useRef(false);
  const isDrawer = variant === 'drawer';
  const isRail = collapsed && !isDrawer;

  // "Search" in the rail expands the sidebar and puts the caret in the field.
  React.useEffect(() => {
    if (isRail || !expandFocusPending.current) return;
    expandFocusPending.current = false;
    searchRef.current?.focus({ preventScroll: true });
  }, [isRail]);

  return (
    <aside
      id={isDrawer ? 'shell-drawer' : 'shell-sidebar'}
      data-collapsed={isRail ? 'true' : 'false'}
      aria-label={isDrawer ? 'Workspace menu' : 'Sidebar'}
      className={cn(
        'glass-strong flex flex-col rounded-panel',
        isDrawer
          ? 'h-full w-full p-3'
          : cn(
              'sticky top-0 hidden h-[100dvh] shrink-0 rounded-none border-y-0 border-l-0 p-3 lg:flex',
              collapsed ? 'px-2' : 'px-3',
            ),
      )}
    >
      <div className={cn('flex items-center', isRail ? 'justify-center' : 'justify-between gap-2')}>
        <Link
          href="/"
          onClick={onNavigate}
          className={cn(
            'flex min-w-0 items-center gap-2.5 rounded-2xl',
            isRail ? 'p-0' : 'px-1.5 py-1.5',
          )}
          aria-label={brand.name}
        >
          <span className="mesh-orb flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/70 shadow-sm">
            <IconBrand className="h-[18px] w-[18px] text-ink" aria-hidden />
          </span>
          {isRail ? null : (
            <span className="min-w-0">
              <span className="block truncate text-[14.5px] font-semibold leading-none tracking-tight">
                {brand.name}
              </span>
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                {brand.tagline}
              </span>
            </span>
          )}
        </Link>

        {/* Expanded: the toggle sits in the header. Collapsed: it gets its own row below the
            brand, because a 72px rail cannot hold both without clipping. */}
        {isDrawer || isRail ? null : (
          <IconButton
            label="Collapse sidebar"
            aria-expanded
            aria-controls="shell-sidebar"
            onClick={onToggle}
            data-shell="sidebar-toggle"
            className="h-11 w-11 shrink-0 lg:h-9 lg:w-9"
          >
            <span aria-hidden className="text-[15px] font-semibold leading-none">
              «
            </span>
          </IconButton>
        )}
      </div>

      {isRail ? (
        <div className="mt-1.5 flex justify-center">
          <IconButton
            label="Expand sidebar"
            aria-expanded={false}
            aria-controls="shell-sidebar"
            onClick={onToggle}
            data-shell="sidebar-toggle"
            className="h-10 w-10"
          >
            <span aria-hidden className="text-[15px] font-semibold leading-none">
              »
            </span>
          </IconButton>
        </div>
      ) : null}

      {isRail ? (
        <div className="mt-2 flex justify-center">
          <IconButton
            label="Search posts (expands the sidebar)"
            onClick={() => {
              onToggle();
              expandFocusPending.current = true;
            }}
            className="h-10 w-10"
          >
            <IconSearch className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>
      ) : (
        <form
          className="px-1 pb-2 pt-2"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch?.(term.trim());
            onNavigate?.();
          }}
        >
          <div className="relative">
            <IconSearch
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              ref={searchRef}
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search…"
              aria-label="Search posts"
              className="h-11 w-full rounded-full border border-white/70 bg-white/60 pl-9 pr-3 text-[16px] text-foreground backdrop-blur-md transition-colors placeholder:text-muted-foreground/80 focus-visible:border-accent/70 focus-visible:bg-white/85 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/20 sm:text-[13px] lg:h-10"
            />
          </div>
        </form>
      )}

      <nav
        aria-label="Workspace"
        className={cn(
          'flex-1',
          // The collapsed rail must NOT clip: its tooltips are absolutely positioned siblings.
          isRail ? 'overflow-visible px-0' : 'no-scrollbar overflow-y-auto px-1',
        )}
      >
        {isRail ? null : (
          <p className="px-2 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
            Workspace
          </p>
        )}
        <NavList
          items={nav}
          pathname={pathname}
          collapsed={isRail}
          onNavigate={onNavigate}
          idPrefix={isDrawer ? 'drawer' : 'side'}
        />
      </nav>

      <div className={cn('mt-2 space-y-2', isRail && 'flex flex-col items-center')}>
        {cta ? (
          isRail ? (
            <Link
              href={cta.href}
              onClick={onNavigate}
              aria-label={cta.label}
              className="ink-pill flex h-10 w-10 items-center justify-center rounded-full transition-transform active:scale-[0.99]"
            >
              <IconApprove className="h-4 w-4" aria-hidden />
            </Link>
          ) : (
            <Link
              href={cta.href}
              onClick={onNavigate}
              className="ink-pill flex h-10 items-center justify-center gap-2 rounded-full text-[12.5px] font-semibold transition-transform active:scale-[0.99]"
            >
              <IconApprove className="h-4 w-4" aria-hidden />
              <span className="truncate">{cta.label}</span>
            </Link>
          )
        ) : null}

        {status && !isRail ? (
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
          <div
            className={cn(
              'flex items-center gap-2 rounded-2xl py-0.5',
              isRail ? 'flex-col' : 'px-1',
            )}
          >
            <span
              className="mesh-orb flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/70 text-[11px] font-semibold text-ink"
              title={isRail ? `${user.name} · ${user.caption}` : undefined}
            >
              {user.initials}
            </span>
            {isRail ? null : (
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium">{user.name}</p>
                <p className="truncate text-[10.5px] text-muted-foreground">{user.caption}</p>
              </div>
            )}
            {user.canSignOut ? (
              <IconButton label="Sign out" onClick={onSignOut} className="h-11 w-11 lg:h-9 lg:w-9">
                <IconSignOut className="h-4 w-4" aria-hidden />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
