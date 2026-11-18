import {
  CalendarClock,
  CheckCircle2,
  FileText,
  History,
  LayoutDashboard,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
}

export const NAV: NavItem[] = [
  {
    href: '/',
    label: 'Overview',
    shortLabel: 'Home',
    icon: LayoutDashboard,
    title: 'Overview',
    subtitle: 'Your content pipeline at a glance',
  },
  {
    href: '/queue/',
    label: 'Content queue',
    shortLabel: 'Queue',
    icon: CalendarClock,
    title: 'Content queue',
    subtitle: 'Topics waiting to become posts',
  },
  {
    href: '/posts/',
    label: 'Generated posts',
    shortLabel: 'Posts',
    icon: FileText,
    title: 'Generated posts',
    subtitle: 'Drafts, approvals and published posts',
  },
  {
    href: '/approvals/',
    label: 'Approvals',
    shortLabel: 'Approve',
    icon: CheckCircle2,
    title: 'Approvals',
    subtitle: 'Nothing is published until you approve',
  },
  {
    href: '/history/',
    label: 'Publishing history',
    shortLabel: 'History',
    icon: History,
    title: 'Publishing history',
    subtitle: 'Everything published to LinkedIn',
  },
  {
    href: '/settings/',
    label: 'Settings',
    shortLabel: 'Settings',
    icon: SettingsIcon,
    title: 'Settings',
    subtitle: 'Schedule, AI voice, integrations and logs',
  },
];

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function pageMeta(pathname: string): { title: string; subtitle: string } {
  const match = NAV.find((item) => isActive(pathname, item.href));
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
