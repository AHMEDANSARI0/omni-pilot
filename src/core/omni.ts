/**
 * OmniFlow integration: API keys for external callers, and signed webhooks going out.
 *
 * Two rules shape this file.
 *
 * 1. A key is never stored. Only its SHA-256 hash is persisted, the plaintext is shown once at creation,
 *    and a lookup is a hash comparison - the same posture as approval tokens. A leaked database dump
 *    therefore contains nothing that can be replayed against the API.
 *
 * 2. A webhook is delivered at least once, never "best effort". Every event gets one delivery row per
 *    endpoint (unique on endpoint+event), attempts are counted, and a failed attempt leaves the row
 *    pending with a backoff - so a tick that crashes mid-delivery does not lose the event and a retried
 *    tick does not duplicate it.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { safeErrorMessage } from './errors';
import { createLogger } from './logger';
import type { ISOInstant } from './types';

export const API_KEY_PREFIX = 'opk_';

export type ApiScope = 'read' | 'write' | 'publish';

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: ApiScope[];
  lastUsedAt: ISOInstant | null;
  revokedAt: ISOInstant | null;
  createdAt: ISOInstant;
}

export interface NewApiKey {
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: ApiScope[];
}

export interface NewWebhookEndpoint {
  name: string;
  url: string;
  secret: string;
  events: string[];
  active?: boolean;
}

export interface WebhookEndpointPatch {
  name?: string;
  url?: string;
  secret?: string;
  events?: string[];
  active?: boolean;
  failureCount?: number;
  lastSuccessAt?: ISOInstant | null;
  lastFailureAt?: ISOInstant | null;
  lastError?: string | null;
}

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  failureCount: number;
  lastSuccessAt: ISOInstant | null;
  lastFailureAt: ISOInstant | null;
  lastError: string | null;
  createdAt: ISOInstant;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  event: string;
  eventId: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivering' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: ISOInstant;
  responseStatus: number | null;
  responseBody: string | null;
  deliveredAt: ISOInstant | null;
  createdAt: ISOInstant;
  /**
   * When this row last changed - which for a claimed delivery is when the claim was written.
   *
   * It was in the table all along (`webhook_deliveries.updated_at`, with a trigger) but not in the type, so no
   * code could ask the one question crash recovery needs: how old is this claim? Without it a delivery left in
   * `delivering` by a dead worker could not be told apart from one that is in flight right now.
   */
  updatedAt: ISOInstant;
}

/** Every event this app can emit. A webhook endpoint subscribes to a subset; '*' means all. */
export const WEBHOOK_EVENTS = [
  'post.generated',
  'post.approved',
  'post.rejected',
  'post.published',
  'post.failed',
  'approval.expired',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Does an endpoint subscribed to `events` want this event? */
export function wantsEvent(events: string[], event: string): boolean {
  if (events.includes('*')) return true;
  return events.includes(event);
}

/* ------------------------------------------------------------------ keys */

/**
 * A new key: `opk_` + 32 random bytes in base64url. The prefix is what the owner sees later, so it is
 * long enough to tell two keys apart and far too short to be useful as a secret.
 */
export function mintApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, API_KEY_PREFIX.length + 6) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex');
}

/** Constant-time comparison for a presented key against a stored hash. */
export function apiKeyMatches(presented: string, keyHash: string): boolean {
  const a = Buffer.from(hashApiKey(presented), 'utf8');
  const b = Buffer.from(keyHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/* --------------------------------------------------------------- signing */

/**
 * The signature OmniFlow verifies: `sha256=<hex>` over `"<timestamp>.<raw body>"`.
 *
 * The timestamp is inside the signed payload on purpose - that is what lets the receiver reject a
 * replayed delivery, and it is why the same body sent twice produces two different headers.
 */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  rawBody: string,
  signature: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  if (!signature.startsWith('sha256=')) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/* ------------------------------------------------------------ retry plan */

export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Minutes to wait before attempt 2, 3, 4 and 5. */
export const WEBHOOK_BACKOFF_MINUTES = [1, 5, 15, 60];

export function webhookBackoffMinutes(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), WEBHOOK_BACKOFF_MINUTES.length - 1);
  return WEBHOOK_BACKOFF_MINUTES[index]!;
}

/**
 * Where the next attempt should land.
 *
 * A 4xx (other than 429) means the receiver understood the request and refused it - retrying a malformed
 * payload five times only annoys the owner, so those fail immediately. 5xx and network errors are
 * transient and get the full schedule.
 */
export function nextDeliveryState(
  attempts: number,
  outcome: { ok: boolean; status?: number; error?: string },
  now: Date,
): { status: WebhookDelivery['status']; nextAttemptAt: ISOInstant; reason: string } {
  const stamp = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  if (outcome.ok) {
    return { status: 'delivered', nextAttemptAt: now.toISOString(), reason: 'delivered' };
  }
  const status = outcome.status ?? 0;
  const permanent = status >= 400 && status < 500 && status !== 429;
  if (permanent) {
    return {
      status: 'failed',
      nextAttemptAt: now.toISOString(),
      reason: `receiver rejected the payload with ${status}`,
    };
  }
  if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
    return {
      status: 'failed',
      nextAttemptAt: now.toISOString(),
      reason: `gave up after ${attempts} attempts (${outcome.error ?? status})`,
    };
  }
  return {
    status: 'pending',
    nextAttemptAt: stamp(webhookBackoffMinutes(attempts)),
    reason: `attempt ${attempts} failed (${outcome.error ?? status}), retrying`,
  };
}

/** Turns a domain event into the payload an endpoint receives. Kept small and stable on purpose. */
export function buildWebhookPayload(
  event: string,
  data: Record<string, unknown>,
  meta: { eventId: string; occurredAt: ISOInstant; baseUrl: string },
): Record<string, unknown> {
  return {
    id: meta.eventId,
    type: event,
    occurredAt: meta.occurredAt,
    // A version in the envelope, so OmniFlow can adopt a new shape without guessing which one it got.
    apiVersion: '2026-11-01',
    source: { app: 'postpilot', url: meta.baseUrl },
    data,
  };
}

/* ---------------------------------------------------------- dispatcher */

export interface WebhookDispatcher {
  listActiveEndpoints(): Promise<WebhookEndpoint[]>;
  enqueue(delivery: {
    endpointId: string;
    event: string;
    eventId: string;
    payload: Record<string, unknown>;
    nextAttemptAt: ISOInstant;
  }): Promise<boolean>;
  claimDue(limit: number): Promise<WebhookDelivery[]>;
  finish(
    id: string,
    patch: {
      status: WebhookDelivery['status'];
      attempts: number;
      nextAttemptAt: ISOInstant;
      responseStatus: number | null;
      responseBody: string | null;
      deliveredAt: ISOInstant | null;
    },
  ): Promise<void>;
  markEndpointResult(
    endpointId: string,
    result: { ok: boolean; error: string | null; at: ISOInstant },
  ): Promise<void>;
}

export type WebhookSender = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ status: number; body: string }>;

/**
 * Records an event once per subscribed endpoint. Returns how many deliveries were queued.
 *
 * The event id is caller-supplied (the post id + event + a timestamp works), and the unique index on
 * (endpoint, event id) is what makes a retried tick idempotent rather than duplicative.
 */
export async function emitWebhookEvent(
  dispatcher: WebhookDispatcher,
  input: {
    event: WebhookEvent | string;
    eventId: string;
    data: Record<string, unknown>;
    baseUrl: string;
    now: Date;
  },
): Promise<number> {
  const endpoints = await dispatcher.listActiveEndpoints();
  const payload = buildWebhookPayload(
    input.event,
    input.data,
    { eventId: input.eventId, occurredAt: input.now.toISOString(), baseUrl: input.baseUrl },
  );
  let queued = 0;
  for (const endpoint of endpoints) {
    if (!wantsEvent(endpoint.events, input.event)) continue;
    const created = await dispatcher.enqueue({
      endpointId: endpoint.id,
      event: input.event,
      eventId: input.eventId,
      payload,
      nextAttemptAt: input.now.toISOString(),
    });
    if (created) queued += 1;
  }
  return queued;
}

/**
 * One delivery pass. Never throws for a single endpoint: a webhook that cannot be delivered is the
 * receiver's problem, not a reason for the cron tick to fail.
 */
export async function deliverDueWebhooks(
  services: { db: { insertLog: (entry: {
    level: 'info' | 'warn' | 'error' | 'debug';
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }) => Promise<void> } },
  dispatcher: WebhookDispatcher,
  send: WebhookSender,
  options: { limit?: number; now?: Date } = {},
): Promise<{ attempted: number; delivered: number; failed: number; retrying: number }> {
  const now = options.now ?? new Date();
  const due = await dispatcher.claimDue(options.limit ?? 10);
  const result = { attempted: 0, delivered: 0, failed: 0, retrying: 0 };

  for (const delivery of due) {
    const endpoint = (await dispatcher.listActiveEndpoints()).find(
      (candidate) => candidate.id === delivery.endpointId,
    );
    result.attempted += 1;
    if (!endpoint) {
      // The endpoint was deleted or deactivated between queueing and delivery.
      await dispatcher.finish(delivery.id, {
        status: 'failed',
        attempts: delivery.attempts,
        nextAttemptAt: now.toISOString(),
        responseStatus: null,
        responseBody: 'endpoint removed',
        deliveredAt: null,
      });
      result.failed += 1;
      continue;
    }

    const rawBody = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(now.getTime() / 1000);
    let outcome: { ok: boolean; status?: number; error?: string; body?: string };
    try {
      const response = await send(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'PostPilot-Webhooks/1',
          'x-postpilot-event': delivery.event,
          'x-postpilot-delivery': delivery.id,
          'x-postpilot-timestamp': String(timestamp),
          'x-postpilot-signature': signWebhook(endpoint.secret, timestamp, rawBody),
        },
        body: rawBody,
      });
      outcome = { ok: response.status >= 200 && response.status < 300, status: response.status, body: response.body };
    } catch (error) {
      outcome = { ok: false, error: safeErrorMessage(error) };
    }

    const next = nextDeliveryState(delivery.attempts, outcome, now);
    await dispatcher.finish(delivery.id, {
      status: next.status,
      attempts: delivery.attempts,
      nextAttemptAt: next.nextAttemptAt,
      responseStatus: outcome.status ?? null,
      responseBody: (outcome.body ?? outcome.error ?? '').slice(0, 500) || null,
      deliveredAt: next.status === 'delivered' ? now.toISOString() : null,
    });
    await dispatcher.markEndpointResult(endpoint.id, {
      ok: outcome.ok,
      error: outcome.ok ? null : next.reason,
      at: now.toISOString(),
    });

    if (next.status === 'delivered') result.delivered += 1;
    else if (next.status === 'failed') result.failed += 1;
    else result.retrying += 1;
  }

  if (result.attempted > 0) {
    await services.db.insertLog({
      level: result.failed > 0 ? 'warn' : 'info',
      event: 'webhooks.delivered',
      message: `${result.delivered} delivered, ${result.retrying} retrying, ${result.failed} failed`,
      context: result,
    });
  }

  return result;
}

/** Convenience: log helper bound to a database, so callers do not repeat the shape. */
export function webhookLogger(services: Parameters<typeof deliverDueWebhooks>[0]) {
  return createLogger(services.db as never);
}
