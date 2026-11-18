'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useApi } from '@/lib/hooks';
import { signOut } from '@/lib/api';
import type { SummaryDto } from '@/lib/types';
import { Alert } from '@/ui';
import { NAV, Shell, initialsFrom, pageMeta, type ShellNavItem } from '@/ui/shell';
import { useAuthMode } from './auth-guard';

/**
 * The only place where the UI shell meets application data. Everything visual
 * lives in `ui/`; this file just decides what to pass in.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const mode = useAuthMode();
  const summary = useApi<SummaryDto>('/overview/summary');
  const reloadSummary = summary.reload;

  React.useEffect(() => {
    reloadSummary();
  }, [pathname, reloadSummary]);

  const pending = summary.data?.pendingApprovals ?? 0;
  const meta = pageMeta(pathname);
  const live = mode?.servicesMode === 'live';
  const initials = initialsFrom(mode?.ownerEmailHint);

  const nav: ShellNavItem[] = NAV.map((item) => ({
    ...item,
    ...(item.href === '/approvals/' && pending > 0 ? { badge: pending } : {}),
  }));

  return (
    <Shell
      nav={nav}
      pathname={pathname}
      brand={{ name: 'PostPilot', tagline: 'LinkedIn automation' }}
      title={meta.title}
      subtitle={meta.subtitle}
      pending={pending}
      live={live}
      dev={Boolean(mode?.devBypass)}
      initials={initials}
      cta={
        pending > 0
          ? {
              href: '/approvals/',
              label: `Review ${pending} approval${pending === 1 ? '' : 's'}`,
            }
          : undefined
      }
      user={{
        name: mode?.ownerEmailHint || 'Owner',
        caption: mode?.devBypass ? 'Dev bypass' : 'Signed in',
        initials,
        canSignOut: Boolean(mode?.requiresAuth && !mode?.devBypass),
      }}
      status={{
        tone: live ? 'live' : 'local',
        title: live ? 'Live services' : 'Local stubs',
        description: live
          ? 'Gemini, Sheets, Resend and LinkedIn are connected.'
          : 'Nothing is really sent or published in this mode.',
      }}
      banner={
        mode?.servicesMode === 'local' ? (
          <Alert tone="warning" className="mt-2 rounded-2xl">
            Local mode: AI, email, Sheets and LinkedIn are stubbed. Nothing is really published.
          </Alert>
        ) : undefined
      }
      onSearch={(term) => router.push(term ? `/posts/?q=${encodeURIComponent(term)}` : '/posts/')}
      onSignOut={() => {
        signOut();
        router.replace('/signin/');
      }}
    >
      {children}
    </Shell>
  );
}
