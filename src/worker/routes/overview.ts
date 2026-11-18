import { Hono } from 'hono';
import { describeSchedule } from '@/src/core/scheduler';
import { safeErrorMessage } from '@/src/core/errors';
import type { ActivityPoint, Trend } from '@/src/core/types';
import { ok } from '../http';
import type { AppEnv } from '../types';

const SERIES_DAYS = 90;
const DAY_MS = 86_400_000;

function sumLast(series: ActivityPoint[], days: number, key: 'generated' | 'published'): number {
  return series.slice(-days).reduce((total, point) => total + point[key], 0);
}

function buildSeries(
  posts: Array<{ runDate: string; publishedAt: string | null }>,
  anchorDate: string,
): ActivityPoint[] {
  const generated = new Map<string, number>();
  const published = new Map<string, number>();

  for (const post of posts) {
    generated.set(post.runDate, (generated.get(post.runDate) ?? 0) + 1);
    if (post.publishedAt) {
      const day = post.publishedAt.slice(0, 10);
      published.set(day, (published.get(day) ?? 0) + 1);
    }
  }

  const anchor = new Date(`${anchorDate}T00:00:00Z`).getTime();
  const series: ActivityPoint[] = [];
  for (let offset = SERIES_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(anchor - offset * DAY_MS).toISOString().slice(0, 10);
    series.push({
      date,
      generated: generated.get(date) ?? 0,
      published: published.get(date) ?? 0,
    });
  }
  return series;
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

  const [latestPosts, logs, sheets, linkedin, email, topics, windowPosts] = await Promise.all([
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
  ]);

  const series = buildSeries(windowPosts, schedule.localDate);
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
    mode: {
      appEnv: services.config.appEnv,
      servicesMode: services.config.servicesMode,
      devBypass: services.config.auth.allowDevBypass,
    },
  });
});
