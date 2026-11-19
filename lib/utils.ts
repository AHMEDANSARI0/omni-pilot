export { cn } from '@/ui/cn';

export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

export function formatDateTime(iso: string | null | undefined, timeZone = 'UTC'): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(parsed);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function truncate(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/**
 * Approval reply time as a short label. A number that has never been measured says so:
 * "not measured yet" - never "0 min", which would read like an instant reply.
 */
export function formatLag(lag: { medianHours: number | null }): string {
  if (lag.medianHours === null) return 'not measured yet';
  if (lag.medianHours < 1) return `${Math.round(lag.medianHours * 60)} min`;
  if (lag.medianHours < 48) return `${lag.medianHours} h`;
  return `${Math.round((lag.medianHours / 24) * 10) / 10} days`;
}
