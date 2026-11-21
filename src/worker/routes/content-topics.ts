import { Hono } from 'hono';
import { AppError, safeErrorMessage } from '@/src/core/errors';
import { addIsoDays, suggestTopics } from '@/src/core/suggestions';
import { DUPLICATE_THRESHOLD, DUPLICATE_WINDOW_DAYS, closest } from '@/src/core/duplicate';
import { buildHookLibrary, hookGuidance } from '@/src/core/hooks';
import { createLogger } from '@/src/core/logger';
import { describeSchedule } from '@/src/core/scheduler';
import { POST_STATUSES, type PostStatus, type TopicStatus } from '@/src/core/types';
import { created, fail, notFound, ok } from '../http';
import { handleAllowedDuplicate } from './content-topic-input';
import {
  parseOrThrow,
  suggestionAcceptSchema,
  suggestionSchema,
  topicCreateSchema,
  topicPatchSchema,
} from '../schemas';
import type { AppEnv } from '../types';

/**
 * Topic queue: list, create (duplicate-guarded), edit, retry, and the Phase 6 planning endpoints
 * (suggestions + hooks). Split out of content.ts so no route file passes the 250-line rule.
 */
export const topicRoutes = new Hono<AppEnv>();

const R = topicRoutes;

R.get('/topics', async (c) => {
  const services = c.get('services');
  const statusParam = c.req.query('status');
  const statuses = statusParam
    ? (statusParam.split(',').filter(Boolean) as TopicStatus[])
    : undefined;
  const topics = await services.db.listTopics({
    statuses,
    from: c.req.query('from'),
    to: c.req.query('to'),
    limit: Number(c.req.query('limit') ?? 200),
  });
  return ok(c, { topics });
});

R.post('/topics', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(topicCreateSchema, await c.req.json().catch(() => ({})));

  // Phase 7: the same duplicate guard the AI suggestions go through. Manual entry is where a repeat
  // is most likely (the owner remembers the idea, not the wording), so it is checked too - and the
  // refusal names the earlier topic, so overriding is a decision rather than a guess.
  if (!body.allowDuplicate) {
    const existing = await services.db.listTopics({ limit: 400 });
    const match = closest(body.topic, existing, (candidate) => candidate.topic);
    if (match) {
      await createLogger(services.db, { actor: c.get('actor') }).warn(
        'topic.duplicate_blocked',
        'Manual topic blocked as a near-duplicate',
        {
          topic: body.topic,
          of: match.item.topic,
          score: match.score,
          duplicateDate: match.item.topicDate,
        },
      );
      throw new AppError(
        'DUPLICATE_TOPIC',
        `"${match.item.topic}" (${match.item.topicDate}) is already ${Math.round(match.score * 100)}% the same idea.`,
        {
          details: {
            duplicateOf: match.item.topic,
            duplicateDate: match.item.topicDate,
            score: match.score,
            hint: 'Send allowDuplicate: true to keep it anyway.',
          },
        },
      );
    }
  }

  try {
    const topic = await services.db.createTopic({
      sheetRowNumber: null,
      topicDate: body.topicDate,
      topic: body.topic,
      contentType: body.contentType,
      slotIndex: body.slotIndex ?? 0,
      keyPoints: body.keyPoints ?? null,
      targetAudience: body.targetAudience ?? null,
    });
    await createLogger(services.db, { actor: c.get('actor') }).info(
      'topic.created',
      'Topic created',
      {
        topicId: topic.id,
        topicDate: topic.topicDate,
      },
    );
    return created(c, { topic });
  } catch (error) {
    // `allowDuplicate: true` keeps a near-duplicate, but it cannot defeat the (date, topic)
    // unique index. That case lives in content-topic-input.ts; anything else is a normal failure.
    if (body.allowDuplicate) {
      const response = await handleAllowedDuplicate(c, services, body, error);
      if (response) return response;
    }
    return fail(c, error);
  }
});

R.patch('/topics/:id', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(topicPatchSchema, await c.req.json().catch(() => ({})));
  const topic = await services.db.updateTopic(c.req.param('id'), {
    status: body.status,
    lastError: null,
  });
  return ok(c, { topic });
});

/**
 * Phase 6 - topic planning. One AI request, nothing stored: the owner reviews the list and
 * adds the ones they want through POST /content/topics (the same path as a manual topic).
 */
R.post('/suggestions', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(suggestionSchema, await c.req.json().catch(() => ({})));
  const log = createLogger(services.db, { actor: c.get('actor') });
  try {
    const [settings, topics] = await Promise.all([
      services.db.getSettings(),
      services.db.listTopics({ limit: 400 }),
    ]);
    const result = await suggestTopics(
      { ai: services.ai, clock: services.clock, db: services.db },
      { settings, existing: topics, count: body.count, startDate: body.startDate },
      log,
    );
    return ok(c, result);
  } catch (error) {
    return fail(c, error);
  }
});

/** Adds reviewed suggestions, skipping dates that are already taken (never overwrites). */
R.post('/suggestions/accept', async (c) => {
  const services = c.get('services');
  const body = parseOrThrow(suggestionAcceptSchema, await c.req.json().catch(() => ({})));
  const log = createLogger(services.db, { actor: c.get('actor') });
  const existing = await services.db.listTopics({ limit: 400 });
  const taken = new Set(existing.map((topic) => topic.topicDate));

  const added: string[] = [];
  const skipped: Array<{ topic: string; reason: string }> = [];
  for (const item of body.topics) {
    if (taken.has(item.topicDate)) {
      skipped.push({ topic: item.topic, reason: `${item.topicDate} already has a topic.` });
      continue;
    }
    try {
      const topic = await services.db.createTopic({
        sheetRowNumber: null,
        topicDate: item.topicDate,
        topic: item.topic,
        contentType: item.contentType,
        keyPoints: item.keyPoints ?? null,
        targetAudience: item.targetAudience ?? null,
      });
      taken.add(topic.topicDate);
      added.push(topic.id);
    } catch (error) {
      skipped.push({ topic: item.topic, reason: safeErrorMessage(error) });
    }
  }

  await log.info('suggestions.accepted', `${added.length} suggested topic(s) added to the queue`, {
    added: added.length,
    skipped: skipped.length,
  });
  return ok(c, { added: added.length, skipped });
});

/**
 * Phase 7 - the hook library, measured from real outcomes.
 *
 * Reads published/approved/rejected posts from the last six months and returns the shapes that
 * worked, the ones the owner rejected and the ones still waiting. Nothing here is scored by a model:
 * a hook is "proven" only because its post actually went live.
 */
R.get('/hooks', async (c) => {
  const services = c.get('services');
  const schedule = await describeSchedule(services);
  const from = addIsoDays(schedule.localDate, -DUPLICATE_WINDOW_DAYS);

  const posts = await services.db.listPosts({ from, limit: 400 });
  const library = buildHookLibrary(posts);

  return ok(c, {
    windowStart: from,
    windowEnd: schedule.localDate,
    threshold: DUPLICATE_THRESHOLD,
    ...library,
    /** Same block the generation prompt gets - shown so the owner can see exactly what was used. */
    promptBlock: hookGuidance(library),
  });
});

topicRoutes.post('/topics/:id/retry', async (c) => {
  const services = c.get('services');
  const topic = await services.db.getTopic(c.req.param('id'));
  if (!topic) return fail(c, notFound('Topic not found'));
  const updated = await services.db.updateTopic(topic.id, { status: 'pending', lastError: null });
  await createLogger(services.db, { actor: c.get('actor') }).info(
    'topic.reset',
    'Topic reset to pending',
    { topicId: topic.id },
  );
  return ok(c, { topic: updated });
});
