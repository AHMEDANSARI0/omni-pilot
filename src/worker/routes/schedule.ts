import { Hono } from 'hono';
import { describeSchedule, runAutomationTick } from '@/src/core/scheduler';
import { requireCronSecret } from '../middleware/auth';
import { ok } from '../http';
import { parseOrThrow, scheduleRunSchema } from '../schemas';
import type { AppEnv } from '../types';

export const scheduleRoutes = new Hono<AppEnv>();

scheduleRoutes.get('/', async (c) => {
  const services = c.get('services');
  const overview = await describeSchedule(services);
  const recentRuns = await services.db.listLogs({ event: 'generation.', limit: 10 });
  return ok(c, { ...overview, recentRuns });
});

scheduleRoutes.post('/run', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(scheduleRunSchema, await c.req.json().catch(() => ({})));
  const result = await runAutomationTick(services, {
    trigger: 'manual',
    force: body.force ?? true,
    runDate: body.runDate,
  });
  return ok(c, result);
});

scheduleRoutes.post('/cron', async (c) => {
  const services = c.get('services');
  requireCronSecret(c.req.raw, services.config.cronSecret);
  const result = await runAutomationTick(services, { trigger: 'cron' });
  return ok(c, result);
});
