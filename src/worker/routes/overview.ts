import { Hono } from 'hono';
import { describeSchedule } from '@/src/core/scheduler';
import { safeErrorMessage } from '@/src/core/errors';
import { ACTIVITY_DAYS, approvalLag, approvalReplyHours, buildActivity } from '@/src/core/activity';
import type { ActivityPoint, Trend } from '@/src/core/types';
import { ok } from '../http';
import type { AppEnv } from '../types';

const SERIES_DAYS = ACTIVITY_DAYS;
const DAY_MS = 86_400_000;

function sumLast(
  series: ActivityPoint[],
  days: number,
  key: 'generated' | 'published',
): number {
  return series.slice(-days).reduce((total, point) => total + point[key], 0);
}

export const overviewRoutes = new Hono<AppEnv>();

overviewRoutes.get('/summary', async (c) => {
  const services = c.get('services');
  const [pendingApprovals, failed, schedule] = await Promise.all([
    services.db.countPosts(['pending_approval']),
    services.db.countPosts(['failed']),
    describeSchedule(services),
  ]);

  return ok(c, {
    pendingApprovals,
    failed,
    nextRunAt: schedule.nextSlot?.generationAt ?? null,
    localDate: schedule.localDate,
  });
});

overviewRoutes.get('/', async (c) => {
  const services = c.get('services');
  const [total, pendingApprovals, published, failed, rejected, approved, expired, schedule] =
    await Promise.all([
      services.db.countPosts(),
      services.db.countPosts(['pending_approval']),
      services.db.countPosts(['published']),
      services.db.countPosts(['failed']),
      services.db.countPosts(['rejected']),
      services.db.countPosts(['approved']),
      services.db.countPosts(['expired']),
      describeSchedule(services),
    ]);

  const since = new Date(
    new Date(`${schedule.localDate}T00:00:00Z`).getTime() - (SERIES_DAYS - 1) * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);

  const [latestPosts, logs, sheets, linkedin, email, topics, windowPosts, approvals] = await Promise.all([
    services.db.listPosts({ limit: 5 }),
    services.db.listLogs({ limit: 12 }),
    services.sheets.describe().catch((error: unknown) => ({
      connected: false,
      sheetLabel: safeErrorMessage(error),
      sheetId: null,
    })),
    services.linkedin
      .status()
      .catch(() => ({ connected: false, label: null, expiresAt: null, needsReauth: true })),
    services.email.describe().catch(() => ({ connected: false, fromEmail: '' })),
    services.db.listTopics({ statuses: ['pending', 'failed', 'claimed'], limit: 5 }),
    services.db.listPosts({ from: since, limit: 600 }).catch(() => []),
    // Decided approvals only: a pending one has no reply time to measure yet.
    services.db
      .listApprovals({ statuses: ['approved', 'rejected', 'expired'], limit: 300 })
      .catch(() => []),
  ]);

  const series = buildActivity(windowPosts, schedule.localDate, ACTIVITY_DAYS);
  const lag = approvalLag(approvals);
  // Debug-by-request only: `/api/v1/overview?inspect=reply-hours` returns the sample the
  // median came from, so the number can be checked against real rows instead of trusted.
  const inspect = c.req.query('inspect') === 'reply-hours';
  const trend: { generated: Trend; published: Trend } = {
    generated: {
      current: sumLast(series, 7, 'generated'),
      previous: sumLast(series.slice(-14, -7), 7, 'generated'),
    },
    published: {
      current: sumLast(series, 7, 'published'),
      previous: sumLast(series.slice(-14, -7), 7, 'published'),
    },
  };

  return ok(c, {
    stats: { total, pendingApprovals, published, failed, rejected, approved, expired },
    schedule,
    integrations: {
      googleSheets: sheets,
      linkedin,
      email,
      ai: { provider: services.ai.id, model: services.ai.model },
    },
    latestPosts,
    upcomingTopics: topics,
    recentLogs: logs,
    series,
    trend,
    approvalLag: lag,
    ...(inspect ? { approvalReplyHours: approvalReplyHours(approvals) } : {}),
    mode: {
      appEnv: services.config.appEnv,
      servicesMode: services.config.servicesMode,
      devBypass: services.config.auth.allowDevBypass,
    },
  });
});
