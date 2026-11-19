import { Hono } from 'hono';
import { buildMonth, monthTotals, upcomingGaps, type CalendarMonth } from '@/src/core/calendar';
import { addIsoDays } from '@/src/core/suggestions';
import { describeSchedule } from '@/src/core/scheduler';
import { ok } from '../http';
import type { AppEnv } from '../types';

/**
 * Phase 6 - the calendar view.
 *
 * One request returns the grid the UI draws plus the gaps that still need a topic. Nothing is
 * stored: a calendar that keeps its own state drifts from the queue within a day.
 */
export const calendarRoutes = new Hono<AppEnv>();

const MONTH_PARAM = /^\d{4}-(0[1-9]|1[0-2])$/;

calendarRoutes.get('/', async (c) => {
  const services = c.get('services');
  const schedule = await describeSchedule(services);

  const requested = c.req.query('month');
  const anchor = MONTH_PARAM.test(requested ?? '') ? (requested as string) : schedule.localDate.slice(0, 7);
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));

  // A generous window: the grid can start in the previous month and end in the next one.
  const from = addIsoDays(`${anchor}-01`, -7);
  const to = addIsoDays(`${anchor}-01`, 40);
  const [topics, posts] = await Promise.all([
    services.db.listTopics({ from, to, limit: 400 }),
    services.db.listPosts({ from, to, limit: 400 }),
  ]);

  const built = buildMonth({
    year,
    month,
    settings: schedule.settings,
    today: schedule.localDate,
    topics,
    posts,
  });

  const payload: {
    month: string;
    label: string;
    today: string;
    timezone: string;
    monthStart: string;
    monthEnd: string;
    gridStart: string;
    gridEnd: string;
    weeks: ReturnType<typeof buildMonth>['weeks'];
    totals: ReturnType<typeof monthTotals>;
    gaps: string[];
  } = {
    month: anchor,
    label: (built as CalendarMonth).label,
    today: schedule.localDate,
    timezone: schedule.settings.ownerTimezone,
    monthStart: built.monthStart,
    monthEnd: built.monthEnd,
    gridStart: built.startDate,
    gridEnd: built.endDate,
    weeks: built.weeks,
    totals: monthTotals(built),
    gaps: upcomingGaps({
      settings: schedule.settings,
      today: schedule.localDate,
      topics,
      posts,
      days: 21,
    }),
  };

  return ok(c, payload);
});
