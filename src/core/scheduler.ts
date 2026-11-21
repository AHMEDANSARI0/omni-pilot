import { safeErrorMessage } from './errors';
import { buildLinkedInExpiryEmail } from './emails';
import { generateDailyPost, type GenerationResult } from './generation';
import { createLogger } from './logger';
import { sendOwnerEmail } from './notify';
import { sweepPublishing, type PublishOutcome } from './publishing';
import { generationDue, nextSlot, slotForDate, slotsForDate } from './schedule';
import { MAX_GENERATION_ATTEMPTS_PER_DAY, type Services } from './services';
import { pruneDiscardedVariants } from './variants';
import { deliverDueWebhooks } from './omni';
import { webhookDispatcherFor } from './omni-dispatch';
import { isoInstant, localDate } from './time';
import type { ScheduledSlot, Settings } from './types';

export interface TickResult {
  ranAt: string;
  localDate: string;
  generation: {
    attempted: boolean;
    reason: string;
    result: GenerationResult | null;
    /** Phase 10: one entry per due slot, so a two-post day reports both drafts. */
    slots: Array<{ slotIndex: number; result: GenerationResult | null }>;
  };
  publishing: PublishOutcome[];
  expiredApprovals: number;
  /** Phase 10: approvals that got a "link is expiring" push this tick. */
  pushWarnings?: number;
  recoveredJobs: number;
  prunedVariants: number;
  /** Phase 10: webhook deliveries attempted in this tick. */
  webhooks: { attempted: number; delivered: number; failed: number; retrying: number };
  linkedInWarningSent: boolean;
  errors: string[];
}

export interface TickOptions {
  trigger: 'cron' | 'manual';
  force?: boolean;
  runDate?: string;
  /** Which post of the day a forced run should generate. Defaults to the first slot. */
  slotIndex?: number;
  skipSync?: boolean;
}

/**
 * One automation tick, executed by the Cloudflare cron trigger every 5 minutes and by the
 * manual "run now" endpoint. Safe to call concurrently: day claims and job claims are
 * atomic in the database.
 */
export async function runAutomationTick(
  services: Services,
  options: TickOptions,
): Promise<TickResult> {
  const now = services.clock.now();
  const settings = await services.db.getSettings();
  const today = localDate(now, settings.ownerTimezone);
  const log = createLogger(services.db, {
    actor: options.trigger,
    extra: { trigger: options.trigger },
  });

  const result: TickResult = {
    ranAt: isoInstant(now),
    localDate: today,
    generation: { attempted: false, reason: 'not evaluated', result: null, slots: [] },
    publishing: [],
    expiredApprovals: 0,
    pushWarnings: 0,
    recoveredJobs: 0,
    prunedVariants: 0,
    webhooks: { attempted: 0, delivered: 0, failed: 0, retrying: 0 },
    linkedInWarningSent: false,
    errors: [],
  };

  try {
    result.recoveredJobs = await services.db.recoverStuckJobs();
  } catch (error) {
    result.errors.push(`recover_stuck_jobs: ${safeErrorMessage(error)}`);
  }

  try {
    result.prunedVariants = await pruneDiscardedVariants(services, log);
  } catch (error) {
    result.errors.push(`prune_variants: ${safeErrorMessage(error)}`);
  }

  try {
    const expired = await services.db.expireStaleApprovals();
    result.expiredApprovals = expired.expiredApprovals;
    if (expired.expiredApprovals > 0) {
      await log.info(
        'scheduler.approvals_expired',
        `${expired.expiredApprovals} approval(s) expired`,
        expired,
      );
    }
  } catch (error) {
    result.errors.push(`expire_approvals: ${safeErrorMessage(error)}`);
  }

  const due = generationDue(settings, now);
  if (options.force) {
    result.generation = await runGeneration(services, options, log, 'manual run requested');
  } else if (!due.due) {
    result.generation = {
      attempted: false,
      reason: due.reason,
      result: null,
      slots: [],
    };
  } else {
    // One tick can owe several drafts (a 10:30 slot and a 15:00 slot both past their generation time).
    // Each slot is claimed separately, so a slot that already succeeded today simply does not claim.
    const outcomes: Array<{ slotIndex: number; result: GenerationResult | null }> = [];
    let firstReason = due.reason;
    for (const slot of due.slots) {
      let claimed = false;
      try {
        claimed =
          slot.slotIndex === 0
            ? await services.db.claimGenerationSlot(today, 0, MAX_GENERATION_ATTEMPTS_PER_DAY)
            : await services.db.claimGenerationSlot(today, slot.slotIndex, MAX_GENERATION_ATTEMPTS_PER_DAY);
      } catch (error) {
        result.errors.push(`claim_generation_slot: ${safeErrorMessage(error)}`);
      }
      if (!claimed) continue;
      const outcome = await runGeneration(services, { ...options, slotIndex: slot.slotIndex }, log, due.reason);
      outcomes.push({ slotIndex: slot.slotIndex, result: outcome.result });
    }

    if (outcomes.length === 0) {
      const state = await services.db.getSchedulerState().catch(() => null);
      result.generation = {
        attempted: false,
        reason:
          state?.lastGenerationDate === today && state.lastGenerationStatus === 'succeeded'
            ? 'Already generated today'
            : 'Generation already claimed or attempt limit reached for today',
        result: null,
        slots: [],
      };
    } else {
      result.generation = {
        attempted: true,
        reason: firstReason,
        result: outcomes[0]!.result,
        slots: outcomes,
      };
    }
  }

  try {
    result.publishing = await sweepPublishing(services, 5);
  } catch (error) {
    const message = safeErrorMessage(error);
    result.errors.push(`publishing_sweep: ${message}`);
    await log.error('scheduler.publishing_sweep_failed', message);
  }

  try {
    // Outbound webhooks go out on every tick, including the ones that only retry a failed delivery.
    result.webhooks = await deliverDueWebhooks(
      { db: services.db },
      webhookDispatcherFor(services),
      (url, init) => services.webhookSender(url, init),
      { now },
    );
  } catch (error) {
    result.errors.push(`webhooks: ${safeErrorMessage(error)}`);
  }

  try {
    // Phase 10: a phone warning before an approval link dies, so the window is not missed silently.
    result.pushWarnings = await warnExpiringApprovals(services, settings);
  } catch (error) {
    result.errors.push(`push_expiry_warning: ${safeErrorMessage(error)}`);
  }

  try {
    result.linkedInWarningSent = await maybeWarnLinkedInExpiry(services, settings);
  } catch (error) {
    result.errors.push(`linkedin_expiry_warning: ${safeErrorMessage(error)}`);
  }

  await services.db
    .updateSchedulerState({ lastPublishSweepAt: isoInstant(now) })
    .catch(() => undefined);

  if (options.trigger === 'cron') {
    await log.debug('scheduler.tick', 'Tick completed', {
      generation: result.generation.reason,
      published: result.publishing.filter((outcome) => outcome.status === 'published').length,
      errors: result.errors.length,
    });
  }

  return result;
}

async function runGeneration(
  services: Services,
  options: TickOptions,
  log: ReturnType<typeof createLogger>,
  reason: string,
): Promise<TickResult['generation']> {
  const settings = await services.db.getSettings();
  const today = localDate(services.clock.now(), settings.ownerTimezone);
  const slotIndex = options.slotIndex ?? 0;
  try {
    const generation = await generateDailyPost(services, {
      runDate: options.runDate,
      slotIndex,
      trigger: options.trigger,
      skipSync: options.skipSync,
    });
    // Close the slot's claim: 'succeeded' makes it unclaimable today, 'failed' leaves room to retry.
    const slotStatus =
      generation.status === 'generated'
        ? 'succeeded'
        : generation.status === 'duplicate'
          ? 'succeeded'
          : generation.status === 'no_topic'
            ? 'no_topic'
            : 'failed';
    await services.db
      .finishGenerationSlot(options.runDate ?? today, slotIndex, slotStatus)
      .catch(() => undefined);
    const status =
      generation.status === 'generated'
        ? 'succeeded'
        : generation.status === 'duplicate'
          ? 'skipped'
          : generation.status === 'no_topic'
            ? 'no_topic'
            : 'failed';
    await services.db
      .updateSchedulerState({
        lastGenerationStatus: status,
        lastGenerationAt: isoInstant(services.clock.now()),
        lastGenerationDate: options.runDate ?? today,
      })
      .catch(() => undefined);
    return { attempted: true, reason, result: generation, slots: [{ slotIndex, result: generation }] };
  } catch (error) {
    const message = safeErrorMessage(error);
    await log.error('scheduler.generation_crashed', message);
    await services.db
      .updateSchedulerState({
        lastGenerationStatus: 'failed',
        lastGenerationAt: isoInstant(services.clock.now()),
      })
      .catch(() => undefined);
    return {
      attempted: true,
      reason,
      result: { status: 'failed', stage: 'unhandled', error: message },
      slots: [{ slotIndex, result: null }],
    };
  }
}

/**
 * Pushes one warning for approvals that expire soon, and only once per approval.
 *
 * The dedupe is the log: an approval that was already warned about has a `push.approval_expiring`
 * entry with its post id, so a tick every five minutes does not become a notification every five
 * minutes.
 */
async function warnExpiringApprovals(services: Services, settings: Settings): Promise<number> {
  const pending = await services.db.listApprovals({ statuses: ['pending'], limit: 20 });
  if (pending.length === 0) return 0;
  const nowMs = services.clock.now().getTime();
  const warned = new Set(
    (await services.db.listLogs({ event: 'push.approval_expiring', limit: 50 })).map(
      (entry) => String((entry.context as { postId?: string } | null)?.postId ?? ''),
    ),
  );

  let sent = 0;
  for (const approval of pending) {
    const hoursLeft = (new Date(approval.expiresAt).getTime() - nowMs) / 3_600_000;
    // Two hours: close enough to act, far enough that the owner is not woken for nothing.
    if (hoursLeft <= 0 || hoursLeft > 2) continue;
    const post = await services.db.getPost(approval.postId);
    if (!post || post.status !== 'pending_approval') continue;
    if (warned.has(post.id)) continue;
    try {
      const { broadcastPushEvent } = await import('./push-send');
      await broadcastPushEvent(services, 'approval.expiring', {
        runDate: post.runDate,
        hoursLeft: Math.max(1, Math.round(hoursLeft)),
      });
    } catch {
      continue;
    }
    await createLogger(services.db, { actor: 'scheduler' })
      .info(
        'push.approval_expiring',
        `Approval for ${post.runDate} expires in about ${Math.round(hoursLeft)}h`,
        { postId: post.id, hoursLeft },
      )
      .catch(() => undefined);
    sent += 1;
  }
  if (sent > 0 && !settings.emailNotifications) {
    // Push is not gated by the email setting here - it is the channel that is still awake.
    return sent;
  }
  return sent;
}

async function maybeWarnLinkedInExpiry(services: Services, settings: Settings): Promise<boolean> {
  const status = await services.linkedin.status();
  if (!status.connected || !status.expiresAt) return false;
  const msLeft = new Date(status.expiresAt).getTime() - services.clock.now().getTime();
  const daysLeft = Math.floor(msLeft / 86_400_000);
  if (daysLeft > 7) return false;

  const recent = await services.db.listLogs({ event: 'linkedin.expiry_warning', limit: 1 });
  const last = recent[0];
  if (
    last &&
    services.clock.now().getTime() - new Date(last.createdAt).getTime() < 20 * 3_600_000
  ) {
    return false;
  }

  const authorizeUrl = `${services.config.baseUrl}/settings/?tab=integrations`;
  const log = createLogger(services.db, { actor: 'scheduler' });
  const sent = await sendOwnerEmail(
    services,
    log,
    buildLinkedInExpiryEmail({
      expiresAt: status.expiresAt,
      daysLeft: Math.max(daysLeft, 0),
      authorizeUrl,
      settings,
    }),
  );
  await log.warn('linkedin.expiry_warning', `LinkedIn access expires in ${daysLeft} day(s)`, {
    expiresAt: status.expiresAt,
    emailSent: sent.sent,
  });
  return sent.sent;
}

/**
 * A webhook-only tick, for the every-minute cron.
 *
 * Phase 10 sent outbound webhooks on the 5-minute automation tick, which made the retry backoff (1 / 5 / 15 /
 * 60 minutes) only as precise as that tick: a delivery due at 10:01 went out at 10:05. This runs the queue
 * alone - no generation, no publishing, no email, no expiry warnings - so it is safe to schedule every
 * minute and cheap when the queue is empty (`claim_webhook_deliveries` returns nothing and the function
 * exits).
 *
 * Deliberately not a second `runAutomationTick`: that would generate and publish five times an hour.
 */
export async function runWebhookTick(
  services: Services,
  options: { limit?: number } = {},
): Promise<{
  attempted: number;
  delivered: number;
  failed: number;
  retrying: number;
  recovered: number;
  errors: string[];
}> {
  const empty = { attempted: 0, delivered: 0, failed: 0, retrying: 0, recovered: 0, errors: [] as string[] };
  try {
    // Crash recovery comes first, for the same reason `runAutomationTick` calls `recoverStuckJobs` before it
    // claims work: a row claimed by a process that then died is invisible to the claim query, which only reads
    // `pending`. Without this, that event is lost for ever - measured on a real database, not assumed.
    // A failure here must not stop the deliveries that are healthy, so it is reported, not thrown.
    let recovered = 0;
    const recoveryErrors: string[] = [];
    try {
      recovered = await services.db.recoverWebhookDeliveries();
      if (recovered > 0) {
        await createLogger(services.db, { actor: 'cron' }).warn(
          'scheduler.webhooks_recovered',
          `Returned ${recovered} abandoned webhook claim(s) to the queue`,
          { recovered },
        );
      }
    } catch (error) {
      recoveryErrors.push(`recover_webhooks: ${safeErrorMessage(error)}`);
    }

    const outcome = await deliverDueWebhooks(
      { db: services.db },
      webhookDispatcherFor(services),
      (url, init) => services.webhookSender(url, init),
      { limit: options.limit ?? 20 },
    );
    return { ...outcome, recovered, errors: recoveryErrors };
  } catch (error) {
    // Same posture as the main tick: a broken webhook endpoint must never break the cron.
    const message = safeErrorMessage(error);
    try {
      const log = createLogger(services.db, { actor: 'cron' });
      await log.error('scheduler.webhook_tick_failed', message);
    } catch {
      // Logging must not be the thing that throws.
    }
    return { ...empty, errors: [message] };
  }
}

export interface ScheduleOverview {
  now: string;
  localDate: string;
  localTime: string;
  settings: Settings;
  generationDueNow: boolean;
  generationReason: string;
  todaySlot: ScheduledSlot;
  /** Phase 10: every slot of today, in publish order. */
  todaySlots: ScheduledSlot[];
  nextSlot: ScheduledSlot | null;
  schedulerState: Awaited<ReturnType<Services['db']['getSchedulerState']>>;
  queuedJobs: number;
  dueJobs: number;
}

export async function describeSchedule(services: Services): Promise<ScheduleOverview> {
  const settings = await services.db.getSettings();
  const now = services.clock.now();
  const today = localDate(now, settings.ownerTimezone);
  const due = generationDue(settings, now);
  const jobs = await services.db.listJobs({ limit: 200 });
  return {
    now: isoInstant(now),
    localDate: today,
    localTime: new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: settings.ownerTimezone,
    }).format(now),
    settings,
    generationDueNow: due.due,
    generationReason: due.reason,
    todaySlot: slotForDate(settings, today),
    todaySlots: slotsForDate(settings, today).slots,
    nextSlot: nextSlot(settings, now),
    schedulerState: await services.db.getSchedulerState(),
    queuedJobs: jobs.filter((job) => job.status === 'queued').length,
    dueJobs: jobs.filter(
      (job) => job.status === 'queued' && new Date(job.runAt).getTime() <= now.getTime(),
    ).length,
  };
}
