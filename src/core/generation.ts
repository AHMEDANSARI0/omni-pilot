import { AppError, isAppError, safeErrorMessage } from './errors';
import { buildApprovalEmail } from './emails';
import { createLogger, type Logger } from './logger';
import { notifyFailure, sendOwnerEmail } from './notify';
import type { GeneratePostInput } from './ports';
import type { Services } from './services';
import {
  generationSheetUpdate,
  safeSheetUpdate,
  syncTopicsFromSheet,
  type SyncResult,
} from './sync';
import { addHours, isoInstant, localDate } from './time';
import { generateApprovalToken, hashApprovalToken } from './tokens';
import { generateDraftOptions, pruneDiscardedVariants, type DraftOption } from './variants';
import { issueApprovalCode } from './whatsapp';
import type { Approval, NewPostVariant, Post, Settings, Topic } from './types';

export type GenerationResult =
  | {
      status: 'generated';
      post: Post;
      approval: Approval;
      approvalEmailSent: boolean;
      approvalEmailError: string | null;
      /** Draft options stored for this post (the first one is already applied). */
      variants: number;
      sheetUpdated: boolean;
      sync: SyncResult | null;
      syncError: string | null;
    }
  | { status: 'duplicate'; post: Post; reason: string }
  | { status: 'no_topic'; reason: string; sync: SyncResult | null; syncError: string | null }
  | { status: 'failed'; stage: string; error: string };

export interface GenerateOptions {
  runDate?: string;
  /** Phase 10: which post of the day (0-based). Defaults to the first slot. */
  slotIndex?: number;
  trigger?: string;
  skipSync?: boolean;
  sendEmail?: boolean;
}

/**
 * The daily pipeline: sync topics -> claim one topic -> generate -> validate -> persist ->
 * update the sheet -> create an approval token -> email the owner.
 *
 * Every stage either succeeds or returns an explicit failure; nothing is marked complete
 * unless the corresponding side effect actually happened.
 */
export async function generateDailyPost(
  services: Services,
  options: GenerateOptions = {},
): Promise<GenerationResult> {
  const settings = await services.db.getSettings();
  const now = services.clock.now();
  const runDate = options.runDate ?? localDate(now, settings.ownerTimezone);
  const slotIndex = options.slotIndex ?? 0;
  const runId = crypto.randomUUID();
  const log = createLogger(services.db, {
    runId,
    actor: options.trigger ?? 'scheduler',
    extra: { runDate, slotIndex },
  });

  await log.info('generation.started', `Generation run for ${runDate}`, {
    trigger: options.trigger ?? 'scheduler',
    model: settings.aiModel,
    slotIndex,
  });

  const existing = await services.db.getPostByDate(runDate, slotIndex);
  if (existing) {
    await log.info('generation.duplicate_skipped', `A post already exists for ${runDate}`, {
      postId: existing.id,
      status: existing.status,
      slotIndex,
    });
    return {
      status: 'duplicate',
      post: existing,
      reason: `A post for ${runDate}${slotIndex > 0 ? ` (slot ${slotIndex + 1})` : ''} already exists (status: ${existing.status}).`,
    };
  }

  let sync: SyncResult | null = null;
  let syncError: string | null = null;
  if (!options.skipSync) {
    try {
      sync = await syncTopicsFromSheet(services, log);
    } catch (error) {
      syncError = safeErrorMessage(error);
      await log.warn(
        'generation.sync_failed',
        `Sheet sync failed, continuing with stored topics: ${syncError}`,
      );
    }
  }

  const topic = await services.db.claimDailyTopic(runDate, 3, slotIndex);
  if (!topic) {
    const reason = `No pending topic found for ${runDate}${slotIndex > 0 ? ` (slot ${slotIndex + 1})` : ''}. Add a row with this DATE and STATUS=Pending.`;
    await log.warn('generation.no_topic', reason, { syncError });
    if (settings.emailNotifications) {
      const { buildNoTopicEmail } = await import('./emails');
      await sendOwnerEmail(
        services,
        log,
        buildNoTopicEmail({
          runDate,
          detail: syncError ? `${reason} Sheet sync also failed: ${syncError}` : reason,
          settings,
          sheetUrl: await sheetUrl(services),
        }),
      );
    }
    return { status: 'no_topic', reason, sync, syncError };
  }

  await log.info('generation.topic_claimed', `Topic: ${topic.topic}`, {
    topicId: topic.id,
    sheetRow: topic.sheetRowNumber,
    attempt: topic.attempts,
  });

  let draftOptions: DraftOption[];
  try {
    const recentPosts = await services.db.listPosts({ limit: 10 });
    draftOptions = await generateDraftOptions(services, settings, topic, recentPosts, log);
  } catch (error) {
    const reason = safeErrorMessage(error);
    await services.db
      .updateTopic(topic.id, { status: 'failed', lastError: reason })
      .catch(() => undefined);
    await log.error('generation.ai_failed', `Content generation failed: ${reason}`, {
      topicId: topic.id,
    });
    await notifyFailure(services, log, {
      runDate,
      stage: 'AI content generation',
      message: reason,
    });
    return { status: 'failed', stage: 'ai_generation', error: reason };
  }

  const chosen = draftOptions[0]!;
  const formatted = chosen.formatted;

  let post: Post;
  try {
    post = await services.db.createPost({
      topicId: topic.id,
      runDate,
      slotIndex,
      hook: formatted.hook,
      body: formatted.body,
      hashtags: formatted.hashtags,
      fullText: formatted.fullText,
      charCount: formatted.charCount,
      provider: services.ai.id,
      model: services.ai.model,
      status: 'pending_approval',
      source: services.config.servicesMode === 'local' ? 'local-dev' : 'ai',
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'CONFLICT') {
      const concurrent = await services.db.getPostByDate(runDate, slotIndex);
      await log.warn(
        'generation.duplicate_race',
        'Another run created the post for this date first',
      );
      if (concurrent)
        return { status: 'duplicate', post: concurrent, reason: 'Post already generated' };
    }
    const reason = safeErrorMessage(error);
    await services.db
      .updateTopic(topic.id, { status: 'failed', lastError: reason })
      .catch(() => undefined);
    await log.error('generation.persist_failed', reason, { topicId: topic.id });
    await notifyFailure(services, log, {
      runDate,
      stage: 'Saving the generated post',
      message: reason,
    });
    return { status: 'failed', stage: 'persist', error: reason };
  }

  await services.db
    .updateTopic(topic.id, { status: 'generated', lastError: null })
    .catch(() => undefined);

  // Store every option so the owner can compare them; failures here must not lose the post.
  const variantRows: NewPostVariant[] = draftOptions.map((option, index) => ({
    variantIndex: index,
    angle: option.angle,
    hook: option.formatted.hook,
    body: option.formatted.body,
    hashtags: option.formatted.hashtags,
    fullText: option.formatted.fullText,
    charCount: option.formatted.charCount,
  }));
  let variantCount = 0;
  try {
    variantCount = (await services.db.createVariants(post.id, variantRows)).length;
  } catch (error) {
    await log.warn('generation.variants_failed', 'Could not store the draft options', {
      postId: post.id,
      error: safeErrorMessage(error),
    });
  }

  const sheetUpdated = await safeSheetUpdate(
    services,
    log,
    generationSheetUpdate(topic, post, settings),
    'generation.sheet_updated',
  );

  const token = generateApprovalToken();
  const tokenHash = await hashApprovalToken(token, services.config.auth.approvalTokenSecret);
  const expiresAt = isoInstant(addHours(now, settings.approvalTtlHours));
  const approval = await services.db.createApproval({ postId: post.id, tokenHash, expiresAt });

  const whatsappLink = await issueApprovalLink(services, log, post.id);

  let approvalEmailSent = false;
  let approvalEmailError: string | null = null;
  if (options.sendEmail !== false) {
    const reviewUrl = `${services.config.baseUrl}/approve/?token=${encodeURIComponent(token)}`;
    const rejectUrl = `${services.config.baseUrl}/approve/?token=${encodeURIComponent(token)}&intent=reject`;
    const email = buildApprovalEmail({
      post,
      topic,
      reviewUrl,
      rejectUrl,
      expiresAt,
      settings,
      whatsappUrl: whatsappLink,
      variantCount,
      variantsUrl: variantCount > 1 ? `${services.config.baseUrl}/posts/` : null,
    });
    const result = await sendOwnerEmail(services, log, email, { respectEmailSetting: true });
    approvalEmailSent = result.sent;
    approvalEmailError = result.error;
    if (result.sent) {
      await services.db
        .updateApproval(approval.id, {
          emailSentAt: isoInstant(now),
          emailMessageId: result.messageId,
        })
        .catch(() => undefined);
    }
  } else {
    approvalEmailError = 'Email skipped by request';
  }

  // Phase 10: the owner's phone hears about the draft too. Independent of the email setting? No:
  // push is a notification channel like email, so it follows the same switch.
  if (settings.emailNotifications) {
    try {
      const { broadcastPushEvent } = await import('./push-send');
      await broadcastPushEvent(services, 'post.ready', {
        runDate: post.runDate,
        slotIndex: post.slotIndex,
      });
    } catch {
      // A push that cannot be sent must never fail the generation run.
    }
  }

  // Phase 10: OmniFlow hears about the draft. Never blocks the run.
  try {
    const { emitWebhookEvent } = await import('./omni');
    const { webhookDispatcherFor } = await import('./omni-dispatch');
    await emitWebhookEvent(webhookDispatcherFor(services), {
      event: 'post.generated',
      eventId: `${post.id}:post.generated`,
      data: { postId: post.id, runDate, slotIndex, variantCount },
      baseUrl: services.config.baseUrl,
      now,
    });
  } catch {
    await log.warn('generation.webhook_failed', 'Could not queue the post.generated webhook');
  }

  await log.info('generation.completed', `Generated post for ${runDate}`, {
    postId: post.id,
    charCount: post.charCount,
    hashtags: post.hashtags,
    variants: variantCount,
    approvalEmailSent,
    sheetUpdated,
  });

  if (!approvalEmailSent && approvalEmailError && options.sendEmail !== false) {
    await notifyFailure(services, log, {
      runDate,
      stage: 'Approval email delivery',
      message: `${approvalEmailError} The draft is saved and can be approved from the dashboard.`,
    });
  }

  return {
    status: 'generated',
    post,
    approval: {
      ...approval,
      emailSentAt: approvalEmailSent ? isoInstant(now) : approval.emailSentAt,
    },
    variants: variantCount,
    approvalEmailSent,
    approvalEmailError,
    sheetUpdated,
    sync,
    syncError,
  };
}

async function sheetUrl(services: Services): Promise<string | null> {
  try {
    const sheet = await services.sheets.describe();
    if (!sheet.sheetId || sheet.sheetId === 'local-dev') return null;
    return `https://docs.google.com/spreadsheets/d/${sheet.sheetId}/edit`;
  } catch {
    return null;
  }
}

/**
 * WhatsApp is an optional second approval channel: a missing credential or a failed write must
 * never block the email approval flow.
 */
async function issueApprovalLink(
  services: Services,
  log: Logger,
  postId: string,
): Promise<string | null> {
  if (!services.config.whatsapp.enabled) return null;
  try {
    const issued = await issueApprovalCode(services, postId);
    return issued.deepLink;
  } catch (error) {
    await log.warn('whatsapp.code_failed', 'Could not create a WhatsApp approval code', {
      postId,
      error: safeErrorMessage(error),
    });
    return null;
  }
}

export { pruneDiscardedVariants };
