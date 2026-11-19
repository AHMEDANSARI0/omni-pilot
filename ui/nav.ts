import {
  IconApprovals,
  IconCalendar,
  IconDashboard,
  IconHistory,
  IconHooks,
  IconPosts,
  IconQueue,
  IconSettings,
  type IconComponent,
} from './icons';

export interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: IconComponent;
  title: string;
  subtitle: string;
}

/** The product navigation. Icons come from the registry, so they always match. */
export const NAV: NavItem[] = [
  {
    href: '/',
    label: 'Overview',
    shortLabel: 'Home',
    icon: IconDashboard,
    title: 'Overview',
    subtitle: 'Your content pipeline at a glance',
  },
  {
    href: '/queue/',
    label: 'Content queue',
    shortLabel: 'Queue',
    icon: IconQueue,
    title: 'Content queue',
    subtitle: 'Topics waiting to become posts',
  },
  {
    href: '/calendar/',
    label: 'Calendar',
    shortLabel: 'Calendar',
    icon: IconCalendar,
    title: 'Calendar',
    subtitle: 'What is planned, approved and published this month',
  },
  {
    href: '/hooks/',
    label: 'Hook library',
    shortLabel: 'Hooks',
    icon: IconHooks,
    title: 'Hook library',
    subtitle: 'Openings that worked, and the ones you rejected',
  },
  {
    href: '/posts/',
    label: 'Generated posts',
    shortLabel: 'Posts',
    icon: IconPosts,
    title: 'Generated posts',
    subtitle: 'Drafts, approvals and published posts',
  },
  {
    href: '/approvals/',
    label: 'Approvals',
    shortLabel: 'Approve',
    icon: IconApprovals,
    title: 'Approvals',
    subtitle: 'Nothing is published until you approve',
  },
  {
    href: '/history/',
    label: 'Publishing history',
    shortLabel: 'History',
    icon: IconHistory,
    title: 'Publishing history',
    subtitle: 'Everything published to LinkedIn',
  },
  {
    href: '/settings/',
    label: 'Settings',
    shortLabel: 'Settings',
    icon: IconSettings,
    title: 'Settings',
    subtitle: 'Schedule, AI voice, integrations and logs',
  },
];

export function pageMeta(pathname: string): { title: string; subtitle: string } {
  const match = NAV.find((item) =>
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href),
  );
  return {
    title: match?.title ?? 'Dashboard',
    subtitle: match?.subtitle ?? 'Personal LinkedIn automation',
  };
}

export function initialsFrom(emailHint: string | null | undefined): string {
  const value = (emailHint ?? '').replace(/[^a-zA-Z0-9@._-]/g, '');
  const local = value.split('@')[0] ?? '';
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();
  return local.length === 1 ? local.toUpperCase() : 'ME';
}
