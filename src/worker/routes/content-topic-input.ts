import type { Context } from 'hono';
import { AppError } from '@/src/core/errors';
import { createLogger } from '@/src/core/logger';
import type { AppEnv } from '../types';
import type { Services } from '@/src/core/services';

/**
 * The `allowDuplicate` branch of POST /content/topics, kept next to the route it belongs to but
 * outside it so the route file stays readable.
 *
 * `allowDuplicate: true` keeps a *near*-duplicate. It cannot defeat the (date, topic) unique index:
 * the exact same topic on the same day is one row. Two honest outcomes, no third:
 *   - the existing row is still queued  -> return it with `alreadyExists: true` (nothing was added)
 *   - the existing row already produced -> DUPLICATE_TOPIC naming its status, so the owner picks
 *                                          another date instead of staring at a raw CONFLICT
 * Returns null for any other error, so the caller falls through to the normal error envelope.
 */
export async function handleAllowedDuplicate(
  c: Context<AppEnv>,
  services: Services,
  topic: { topicDate: string; topic: string },
  error: unknown,
): Promise<Response | null> {
  if (!(error instanceof AppError) || error.code !== 'CONFLICT') return null;

  const sameDay = await services.db.listTopics({ from: topic.topicDate, to: topic.topicDate });
  const exact = sameDay.find(
    (candidate) => candidate.topic.trim().toLowerCase() === topic.topic.trim().toLowerCase(),
  );
  if (!exact) return null;

  const log = createLogger(services.db, { actor: c.get('actor') });
  const stillQueued =
    exact.status === 'pending' || exact.status === 'failed' || exact.status === 'skipped';

  if (stillQueued) {
    await log.info('topic.already_queued', 'Topic already queued for that date - nothing added', {
      topicId: exact.id,
      topicDate: exact.topicDate,
      status: exact.status,
    });
    return c.json({ ok: true, data: { topic: exact, alreadyExists: true } }, 200);
  }

  throw new AppError(
    'DUPLICATE_TOPIC',
    `"${exact.topic}" already exists for ${exact.topicDate} and is already ${exact.status}. ` +
      'Pick another date or a different topic.',
    {
      details: {
        duplicateOf: exact.topic,
        duplicateDate: exact.topicDate,
        status: exact.status,
        hint: 'That row already produced content; use a different date.',
      },
    },
  );
}
