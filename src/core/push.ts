/**
 * Web push, without the Web Push protocol.
 *
 * Honest scope note: encrypting a payload for a push service needs ECDH on P-256 plus HKDF and AES-GCM
 * (RFC 8291), which is a lot of crypto to hand-write into a Worker. So this file does the two things the
 * app actually needs and does them properly:
 *
 *   - **Subscription management**: store, de-duplicate, and retire dead endpoints.
 *   - **The decision layer**: which notifications are worth sending, and to whom. A push that fires on
 *     every log line is a push the owner turns off after a day.
 *
 * The actual send goes through `PushSender`, an injected function (like the webhook sender). The default
 * implementation posts to the endpoint when VAPID keys are configured and reports honestly when they are
 * not - it never pretends a notification was delivered.
 */
import { safeErrorMessage } from './errors';
import type { ISOInstant } from './types';

export interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  failureCount: number;
  lastSuccessAt: ISOInstant | null;
  lastError: string | null;
  createdAt: ISOInstant;
}

export interface NewPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

/** Which events are worth a phone buzzing. Everything else stays in the dashboard. */
export const PUSH_EVENTS = [
  'post.ready', // a draft is waiting for approval
  'post.failed', // publishing failed and needs a human
  'approval.expiring', // an approval link is about to run out
] as const;

export type PushEvent = (typeof PUSH_EVENTS)[number];

export interface PushNotification {
  event: PushEvent;
  title: string;
  body: string;
  url: string;
  /** Collapses repeat notifications of the same kind on the device. */
  tag?: string;
}

export interface PushSender {
  (
    subscription: Pick<PushSubscription, 'endpoint' | 'p256dh' | 'auth'>,
    notification: PushNotification,
  ): Promise<{ ok: boolean; status?: number; error?: string }>;
}

/** Validates what a browser sends to /push/subscribe before it is stored. */
export function parseSubscription(body: unknown): NewPushSubscription | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint : '';
  const keys = (record.keys ?? {}) as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (!endpoint.startsWith('https://')) return null;
  if (p256dh.length < 20 || auth.length < 8) return null;
  return {
    endpoint,
    p256dh,
    auth,
    userAgent: typeof record.userAgent === 'string' ? record.userAgent.slice(0, 300) : null,
  };
}

/**
 * The notifications this app sends, written once so the wording is the same everywhere.
 * Each one answers "what should I do now?" - that is the only reason to interrupt someone.
 */
export function notificationFor(
  event: PushEvent,
  data: {
    runDate?: string;
    postId?: string;
    reason?: string;
    hoursLeft?: number;
    /** Phase 10: which post of the day, so a two-post day says which one is waiting. */
    slotIndex?: number;
  },
): PushNotification {
  switch (event) {
    case 'post.ready':
      return {
        event,
        title: 'Your draft is ready',
        body: `The post for ${data.runDate ?? 'today'}${data.slotIndex ? ` (post ${data.slotIndex + 1} of the day)` : ''} is waiting for your approval.`,
        url: '/approvals/',
        tag: 'post-ready',
      };
    case 'post.failed':
      return {
        event,
        title: 'Publishing failed',
        body: `${data.reason ?? 'LinkedIn refused the post.'} The draft is safe - retry from the dashboard.`,
        url: `/posts/`,
        tag: 'post-failed',
      };
    case 'approval.expiring':
      return {
        event,
        title: 'Approval link expiring',
        body: `An approval for ${data.runDate ?? 'a draft'} expires in about ${data.hoursLeft ?? 2} hours.`,
        url: '/approvals/',
        tag: 'approval-expiring',
      };
  }
}

/**
 * Sends one notification to every live subscription.
 *
 * A 404/410 means the endpoint is gone (the browser was uninstalled, or the subscription expired) - that
 * row is retired rather than retried forever. Any other failure is counted, and five in a row switches
 * the device off until it subscribes again.
 */
export async function broadcastPush(
  subscriptions: PushSubscription[],
  send: PushSender,
  notification: PushNotification,
  onResult: (id: string, result: { ok: boolean; status?: number; error?: string }) => Promise<void> = async () => undefined,
): Promise<{ sent: number; failed: number; retired: number }> {
  const result = { sent: 0, failed: 0, retired: 0 };
  for (const subscription of subscriptions) {
    if (subscription.failureCount >= 5) {
      result.retired += 1;
      continue;
    }
    let outcome: { ok: boolean; status?: number; error?: string };
    try {
      outcome = await send(subscription, notification);
    } catch (error) {
      outcome = { ok: false, error: safeErrorMessage(error) };
    }
    const gone = outcome.status === 404 || outcome.status === 410;
    try {
      await onResult?.(subscription.id, outcome);
    } catch {
      // Recording a result is bookkeeping: a failure there must not stop the other devices.
    }
    if (outcome.ok) result.sent += 1;
    else {
      result.failed += 1;
      if (gone) result.retired += 1;
    }
  }
  return result;
}

export const PUSH_MAX_FAILURES = 5;
