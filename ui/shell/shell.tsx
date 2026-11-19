'use client';

import * as React from 'react';
import { cn } from '../cn';
import { Drawer } from './drawer';
import { MobileTabBar, Topbar } from './topbar';
import { Sidebar, type ShellNavItem } from './sidebar';
import {
  applySidebarState,
  nextSidebarState,
  readSidebarState,
  writeSidebarState,
  type SidebarState,
} from './sidebar-state';

/**
 * The application frame.
 *
 * Layout contract (the reason this file exists):
 *
 *   - The rail is pinned to the left edge of the window and is 100dvh tall. It does not
 *     float, and it does not move when the page scrolls.
 *   - The content area starts exactly where the rail ends (`padding-left: var(--sidebar-w)`),
 *     so nothing ever slides underneath it.
 *   - Only the *reading column* is capped (--content-max). The shell itself is full width,
 *     which is what keeps the rail against the edge instead of centred on big screens.
 *
 * All three numbers live in ui/tokens.css; this component only arranges them.
 */
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
  const [sidebar, setSidebar] = React.useState<SidebarState>('expanded');
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Read the saved choice after mount (the export is static, so there is no cookie to read).
  React.useEffect(() => {
    const saved = readSidebarState();
    setSidebar(saved);
    applySidebarState(saved);
  }, []);

  const toggleSidebar = React.useCallback(() => {
    setSidebar((current) => {
      const next = nextSidebarState(current);
      writeSidebarState(next);
      applySidebarState(next);
      return next;
    });
  }, []);

  // Route changes close the drawer; a wide viewport never keeps it open.
  React.useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!drawerOpen) return;
    const media = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (media.matches) setDrawerOpen(false);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [drawerOpen]);

  // Keyboard shortcut: [ toggles the rail, like an editor sidebar.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '[' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      toggleSidebar();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  const sidebarProps = {
    nav,
    pathname,
    brand,
    status,
    user,
    cta,
    onSearch,
    onSignOut,
  };

  return (
    <div className="min-h-[100dvh] w-full max-w-full overflow-x-clip">
      {/* Desktop rail: fixed to the window, full height, width from CSS. */}
      <div className="hidden lg:block">
        <div className="fixed inset-y-0 left-0 z-40 w-[var(--sidebar-w)] transition-[width] duration-200 ease-out">
          <Sidebar {...sidebarProps} collapsed={sidebar === 'collapsed'} onToggle={toggleSidebar} />
        </div>
      </div>

      {/* Mobile sheet */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Sidebar
          {...sidebarProps}
          collapsed={false}
          variant="drawer"
          onToggle={toggleSidebar}
          onNavigate={() => setDrawerOpen(false)}
        />
      </Drawer>

      <div className="flex min-h-[100dvh] w-full min-w-0 flex-col lg:pl-[var(--sidebar-w)]">
        <Topbar
          title={title}
          subtitle={subtitle}
          actions={topbarActions}
          pending={pending}
          live={live}
          dev={dev}
          initials={initials}
          onOpenMenu={() => setDrawerOpen(true)}
        />

        {banner ? <div className="px-3 pt-2 sm:px-4">{banner}</div> : null}

        {/* The reading column - the only thing that is capped. */}
        <main
          className={cn(
            'mx-auto w-full min-w-0 max-w-[var(--content-max)] flex-1',
            'px-3 py-3 pb-28 sm:px-4 sm:py-4 lg:px-6 lg:py-5 lg:pb-10',
          )}
        >
          {children}
        </main>
      </div>

      <MobileTabBar nav={nav} pathname={pathname} />
    </div>
  );
}
