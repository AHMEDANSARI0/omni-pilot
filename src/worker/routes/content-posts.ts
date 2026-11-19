import { Hono } from 'hono';
import { AppError } from '@/src/core/errors';
import { validateDraft, splitPostText, countChars } from '@/src/core/format';
import { createLogger } from '@/src/core/logger';
import { POST_STATUSES, type PostStatus } from '@/src/core/types';
import { selectPostVariant } from '@/src/core/variants';
import { fail, notFound, ok } from '../http';
import { parseOrThrow, postPatchSchema, postsQuerySchema } from '../schemas';
import type { AppEnv } from '../types';

/** Posts: listing, detail, owner edits and draft-option selection. */
export const postRoutes = new Hono<AppEnv>();

const R = postRoutes;

R.get('/posts', async (c) => {
  const services = c.get('services');
  const query = parseOrThrow(postsQuerySchema, {
    status: c.req.query('status') ?? undefined,
    from: c.req.query('from') ?? undefined,
    to: c.req.query('to') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    offset: c.req.query('offset') ?? undefined,
  });
  const statuses = query.status
    ? (query.status
        .split(',')
        .filter((value) => POST_STATUSES.includes(value as PostStatus)) as PostStatus[])
    : undefined;
  const posts = await services.db.listPosts({
    statuses,
    from: query.from,
    to: query.to,
    limit: query.limit,
    offset: query.offset,
  });

  // The compare view needs the options inline; asking for them is opt-in to keep the list small.
  if (c.req.query('variants') !== '1') return ok(c, { posts });

  const withVariants = await Promise.all(
    posts.slice(0, 40).map(async (post) => ({
      ...post,
      variants: await services.db.listVariants(post.id).catch(() => []),
    })),
  );
  const rest = posts.slice(40).map((post) => ({ ...post, variants: [] }));
  return ok(c, { posts: [...withVariants, ...rest] });
});

R.get('/posts/:id/variants', async (c) => {
  const services = c.get('services');
  const post = await services.db.getPost(c.req.param('id'));
  if (!post) return fail(c, notFound('Post not found'));
  return ok(c, { variants: await services.db.listVariants(post.id) });
});

R.post('/posts/:id/variants/:variantId/select', async (c) => {
  const services = c.get('services');
  try {
    const result = await selectPostVariant(services, {
      postId: c.req.param('id'),
      variantId: c.req.param('variantId'),
      actor: c.get('actor'),
    });
    return ok(c, result);
  } catch (error) {
    return fail(c, error);
  }
});

R.get('/posts/:id', async (c) => {
  const services = c.get('services');
  const post = await services.db.getPost(c.req.param('id'));
  if (!post) return fail(c, notFound('Post not found'));
  const [topic, approval, job, variants] = await Promise.all([
    post.topicId ? services.db.getTopic(post.topicId) : Promise.resolve(null),
    services.db.getActiveApprovalForPost(post.id),
    services.db.getJobByPost(post.id),
    services.db.listVariants(post.id).catch(() => []),
  ]);
  return ok(c, { post, topic, approval, job, variants });
});

R.patch('/posts/:id', async (c) => {
  const services = c.get('services');
  const postId = c.req.param('id');
  const body = parseOrThrow(postPatchSchema, await c.req.json().catch(() => ({})));
  const post = await services.db.getPost(postId);
  if (!post) return fail(c, notFound('Post not found'));
  if (['published', 'publishing'].includes(post.status)) {
    return fail(c, new AppError('CONFLICT', 'Published or in-flight posts cannot be edited.'));
  }

  const settings = await services.db.getSettings();
  const split = splitPostText(body.fullText);
  const validated = validateDraft(split, {
    maxChars: settings.maxPostChars,
    hashtagMin: settings.hashtagMin,
    hashtagMax: settings.hashtagMax,
  });
  if (countChars(validated.fullText) > settings.maxPostChars) {
    return fail(
      c,
      new AppError('VALIDATION_FAILED', `Post exceeds ${settings.maxPostChars} characters.`),
    );
  }

  const updated = await services.db.updatePost(postId, {
    hook: validated.hook,
    body: validated.body,
    hashtags: validated.hashtags,
    fullText: validated.fullText,
    charCount: validated.charCount,
    editedByOwner: true,
  });
  await createLogger(services.db, { actor: c.get('actor') }).info(
    'post.edited',
    'Post edited by owner',
    {
      postId,
      charCount: updated.charCount,
    },
  );
  return ok(c, { post: updated, issues: validated.issues });
});
