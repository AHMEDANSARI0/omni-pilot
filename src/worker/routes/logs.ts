import { Hono } from 'hono';
import { ok } from '../http';
import { logsQuerySchema, parseOrThrow } from '../schemas';
import type { AppEnv } from '../types';

export const logRoutes = new Hono<AppEnv>();

logRoutes.get('/', async (c) => {
  const services = c.get('services');
  const query = parseOrThrow(logsQuerySchema, {
    level: c.req.query('level') ?? undefined,
    event: c.req.query('event') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
  });
  const logs = await services.db.listLogs({
    level: query.level,
    event: query.event,
    limit: query.limit ?? 100,
  });
  return ok(c, { logs });
});
