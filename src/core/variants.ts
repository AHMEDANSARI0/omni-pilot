import { checkDraft } from './duplicate';
import { AppError } from './errors';
import { hardIssues, validateDraft } from './format';
import { buildHookLibrary, hookGuidance } from './hooks';
import { createLogger, type Logger } from './logger';
import type { GeneratePostInput } from './ports';
import type { Services } from './services';
import { addHours, isoInstant } from './time';
import type { DraftVariant, FormatResult, Post, PostVariant, Settings, Topic } from './types';

/** How many drafts one generation call asks for. One request keeps the free quota intact. */
export const DRAFT_VARIANT_COUNT = 3;

/** A validated draft option, ready to be stored. */
export interface DraftOption {
  angle: string;
  formatted: FormatResult;
}

export interface SelectVariantInput {
  postId: string;
  variantId: string;
  actor?: string;
}

export interface SelectVariantResult {
  post: Post;
  variants: PostVariant[];
}

/**
 * Asks the AI for several takes on one topic and validates each of them.
 *
 * - one provider request per attempt (never one per variant)
 * - a draft with blocking issues is dropped, the remaining ones are still usable
 * - if every draft is unusable the attempt is repeated once with the issues spelled out
 */
export async function generateDraftOptions(
  services: Services,
  settings: Settings,
  topic: Topic,
  recentPosts: Post[],
  log: Logger,
  count: number = DRAFT_VARIANT_COUNT,
): Promise<DraftOption[]> {
  const baseInput: GeneratePostInput = {
    topic: topic.topic,
    contentType: topic.contentType,
    keyPoints: topic.keyPoints,
    targetAudience: topic.targetAudience,
    brandVoice: settings.brandVoice,
    writingInstructions: settings.writingInstructions,
    hashtagMin: settings.hashtagMin,
    hashtagMax: settings.hashtagMax,
    maxChars: settings.maxPostChars,
    recentHooks: recentPosts
      .map((post) => post.hook)
      .filter(Boolean)
      .slice(0, 8),
    // Phase 7: what actually worked for this owner, and what they rejected.
    hookLibrary: hookGuidance(buildHookLibrary(recentPosts)),
  };

  const formatOptions = {
    maxChars: settings.maxPostChars,
    hashtagMin: settings.hashtagMin,
    hashtagMax: settings.hashtagMax,
  };

  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const input: GeneratePostInput =
      attempt === 1
        ? baseInput
        : {
            ...baseInput,
            writingInstructions: `${baseInput.writingInstructions}\n\nThe previous drafts had these problems - fix all of them: ${lastIssues.join(' | ')}`,
          };

    const drafts = await draftOnce(services, input, count);
    const options: DraftOption[] = [];
    const problems: string[] = [];

    for (const draft of drafts) {
      const formatted = validateDraft(draft, formatOptions);
      const blocking = hardIssues(formatted.issues);
      if (blocking.length > 0) {
        problems.push(...blocking);
        continue;
      }

      // Phase 7: a draft that repeats recent work is not an option, it is a mistake. It is dropped
      // with the reason, so the retry gets told what to avoid instead of being fed it again.
      const repeat = checkDraft(
        { hook: formatted.hook, body: formatted.body },
        recentPosts.map((post) => ({ hook: post.hook, body: post.body, runDate: post.runDate })),
      );
      if (repeat.duplicate) {
        problems.push(`Repeats earlier work: ${repeat.reason}`);
        await log.warn('generation.duplicate_draft', `Dropped a draft that repeats recent work`, {
          reason: repeat.reason,
          score: repeat.score,
          matchOf: repeat.matchOf,
        });
        continue;
      }

      options.push({
        angle: cleanAngle(draft.angle, options.length + 1),
        formatted,
      });
    }

    if (options.length > 0) {
      if (problems.length > 0) {
        await log.warn(
          'generation.variant_rejected',
          `Dropped ${problems.length} issue(s) from ${drafts.length} draft option(s)`,
          { issues: problems },
        );
      }
      return options.slice(0, count);
    }

    lastIssues = [...new Set(problems)];
    await log.warn('generation.content_needs_work', `Draft attempt ${attempt} had issues`, {
      issues: lastIssues,
    });
  }

  throw new AppError('AI_ERROR', `Generated content failed validation: ${lastIssues.join('; ')}`);
}

async function draftOnce(
  services: Services,
  input: GeneratePostInput,
  count: number,
): Promise<DraftVariant[]> {
  if (services.ai.generateVariants) {
    const variants = await services.ai.generateVariants(input, count);
    if (variants.length > 0) return variants;
  }
  const single = await services.ai.generatePost(input);
  return [{ ...single, angle: 'Draft' }];
}

function cleanAngle(angle: string | undefined, position: number): string {
  const trimmed = (angle ?? '').trim();
  if (!trimmed) return `Option ${position}`;
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

/**
 * Applies a stored draft option to its post. The post stays the single source of truth, so
 * approvals, publishing and the sheet all continue to work unchanged.
 */
export async function selectPostVariant(
  services: Services,
  input: SelectVariantInput,
): Promise<SelectVariantResult> {
  const post = await services.db.getPost(input.postId);
  if (!post) throw new AppError('NOT_FOUND', 'Post not found');

  if (!['draft', 'pending_approval'].includes(post.status)) {
    throw new AppError(
      'CONFLICT',
      `This post is already ${post.status.replace('_', ' ')}; the draft options can no longer be swapped.`,
    );
  }
  if (post.editedByOwner) {
    throw new AppError(
      'CONFLICT',
      'You edited this post by hand, so the generated options are no longer in play.',
    );
  }

  const variants = await services.db.listVariants(post.id);
  if (variants.length === 0) {
    throw new AppError('NOT_FOUND', 'This post has no stored draft options.');
  }
  const target = variants.find((variant) => variant.id === input.variantId);
  if (!target) throw new AppError('NOT_FOUND', 'That draft option does not belong to this post.');

  if (target.selected) {
    return { post, variants };
  }

  const settings = await services.db.getSettings();
  if (target.charCount > settings.maxPostChars) {
    throw new AppError(
      'VALIDATION_FAILED',
      `That option is ${target.charCount} characters, over your ${settings.maxPostChars} limit.`,
    );
  }

  await services.db.selectVariant(post.id, target.id, isoInstant(services.clock.now()));

  const updated = await services.db.updatePost(post.id, {
    hook: target.hook,
    body: target.body,
    hashtags: target.hashtags,
    fullText: target.fullText,
    charCount: target.charCount,
    source: 'variant',
    editedByOwner: false,
  });

  await createLogger(services.db, { actor: input.actor ?? 'dashboard' }).info(
    'post.variant_selected',
    `Draft option "${target.angle}" applied to the post`,
    { postId: post.id, variantId: target.id, angle: target.angle, charCount: target.charCount },
  );

  return { post: updated, variants: await services.db.listVariants(post.id) };
}

/** Keeps the table small: discarded options are dropped 24h after they lost. */
export async function pruneDiscardedVariants(services: Services, log?: Logger): Promise<number> {
  const cutoff = isoInstant(addHours(services.clock.now(), -24));
  try {
    const removed = await services.db.pruneVariants(cutoff);
    if (removed > 0 && log) {
      await log.debug('variants.pruned', `Removed ${removed} discarded draft option(s)`, {
        before: cutoff,
      });
    }
    return removed;
  } catch {
    // Housekeeping must never break the tick.
    return 0;
  }
}
