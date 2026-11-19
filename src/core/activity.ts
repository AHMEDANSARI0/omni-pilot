import type { ActivityPoint, Approval, Post } from './types';

/**
 * Phase 6 - the numbers behind the dashboard chart.
 *
 * Everything here is derived from rows the system already stores; nothing is estimated or
 * back-filled. Two rules:
 *   - one bucket per local date, always `days` buckets, so the chart never changes width
 *   - a value that cannot be computed stays `null` (and the UI says so) instead of showing 0
 */

export const ACTIVITY_DAYS = 90;
const DAY_MS = 86_400_000;

function dayOf(instant: string): string {
  return instant.slice(0, 10);
}

function shift(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`).getTime();
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * How long the owner took to answer an approval email, in hours.
 *
 * Measured as `usedAt - emailSentAt` on approvals that were actually decided. Approvals whose
 * email never went out, or that are still waiting, carry no signal and are skipped - a slow
 * reply and a never-sent email must not look the same.
 */
export function approvalReplyHours(approvals: Approval[]): number[] {
  const hours: number[] = [];
  for (const approval of approvals) {
    if (!approval.usedAt || !approval.emailSentAt) continue;
    const sent = new Date(approval.emailSentAt).getTime();
    const used = new Date(approval.usedAt).getTime();
    if (!Number.isFinite(sent) || !Number.isFinite(used) || used < sent) continue;
    hours.push((used - sent) / 3_600_000);
  }
  return hours;
}

export interface ApprovalLag {
  /** Median reply time in hours, rounded to one decimal. `null` when there is nothing to measure. */
  medianHours: number | null;
  /** How many decided approvals the number is based on. */
  sample: number;
}

export function approvalLag(approvals: Approval[]): ApprovalLag {
  const hours = approvalReplyHours(approvals).sort((a, b) => a - b);
  if (hours.length === 0) return { medianHours: null, sample: 0 };
  const middle = Math.floor(hours.length / 2);
  const median =
    hours.length % 2 === 0 ? (hours[middle - 1]! + hours[middle]!) / 2 : hours[middle]!;
  return { medianHours: Math.round(median * 10) / 10, sample: hours.length };
}

/**
 * Drafts generated, posts published and drafts that failed, bucketed by local date.
 *
 * `generated` and `failed` follow the draft's own run date (that is the day the owner expects
 * to see); `published` follows the instant LinkedIn accepted the post. The two are different
 * days on purpose - a post approved late can publish the next morning.
 */
export function buildActivity(
  posts: Array<Pick<Post, 'runDate' | 'status' | 'publishedAt'>>,
  anchorDate: string,
  days: number = ACTIVITY_DAYS,
): ActivityPoint[] {
  const buckets = new Map<string, ActivityPoint>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = shift(anchorDate, -offset);
    buckets.set(date, { date, generated: 0, published: 0, failed: 0 });
  }

  for (const post of posts) {
    const created = buckets.get(post.runDate);
    if (created) {
      created.generated += 1;
      if (post.status === 'failed' && created.failed !== undefined) created.failed += 1;
    }
    if (post.publishedAt) {
      const published = buckets.get(dayOf(post.publishedAt));
      if (published) published.published += 1;
    }
  }

  return [...buckets.values()];
}
