import { AppError, safeErrorMessage } from './errors';
import { addHours, isoInstant } from './time';
import { hashApprovalToken } from './tokens';
import { createLogger } from './logger';
import { decideApproval } from './approval';
import type { Services } from './services';
import type { WhatsAppInbound } from './ports';

/**
 * WhatsApp approval channel.
 *
 * Everything the owner receives is free: the approval email carries a `wa.me` link with a
 * short code already typed in it, the owner sends that text (an inbound service message,
 * always free), which opens the 24 h customer-service window, and the bot replies with the
 * post and two buttons. Meta bills template messages from the first one, so this module never
 * sends a template: every reply is a free-form message inside a window the owner opened.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'APR';
const CODE_TOKEN = '[A-HJ-NP-Z2-9]{6}';
const CODE_PATTERN = new RegExp(`\\b${CODE_PREFIX}[\\s-]?(${CODE_TOKEN})\\b`, 'i');
const TEXT_LIMIT = 3_500;
const TTL_HOURS = 12;

export interface IssuedApprovalCode {
  code: string;
  expiresAt: string;
  deepLink: string | null;
}

export interface InboundOutcome {
  handled: boolean;
  reason: string;
}

export interface WebhookResult {
  ok: boolean;
  status: number;
  processed: number;
  reason?: string;
}

/** Result of handling one inbound message, used by the webhook route for logging. */
export function normalizePhone(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9]/g, '');
}

/** Only the last four digits are ever rendered; the rest never leaves the runtime. */
export function maskPhone(value: string | null): string | null {
  const digits = normalizePhone(value);
  if (digits.length < 5) return null;
  return `+•••• ${digits.slice(-4)}`;
}

export function generateApprovalCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let body = '';
  for (const byte of bytes) body += ALPHABET[byte % ALPHABET.length];
  return `${CODE_PREFIX}-${body}`;
}

/** Accepts `APR-ABC123`, `apr abc123`, `ABC123` … and returns the canonical form. */
export function normalizeApprovalCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = CODE_PATTERN.exec(input.replace(/\s+/g, ' ').trim());
  return match?.[1] ? `${CODE_PREFIX}-${match[1].toUpperCase()}` : null;
}

export function buildApprovalLink(ownerNumber: string | null, code: string): string | null {
  const digits = normalizePhone(ownerNumber);
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(code)}`;
}

/** Issues a 12 h single-use code (only its HMAC is stored) and the matching wa.me link. */
export async function issueApprovalCode(
  services: Services,
  postId: string,
): Promise<IssuedApprovalCode> {
  const code = generateApprovalCode();
  const expiresAt = isoInstant(addHours(services.clock.now(), TTL_HOURS));
  await services.db.createWhatsAppCode({
    codeHash: await hashApprovalToken(code, services.config.auth.approvalTokenSecret),
    postId,
    expiresAt,
  });
  return {
    code,
    expiresAt,
    deepLink: buildApprovalLink(services.config.whatsapp.ownerNumber, code),
  };
}

export function whatsappStatus(services: Services) {
  const { enabled, ownerNumber } = services.config.whatsapp;
  const connected = enabled && services.whatsapp.id === 'whatsapp-cloud';
  return {
    connected,
    mode: connected ? ('cloud' as const) : ('disabled' as const),
    number: maskPhone(ownerNumber),
    reason: connected
      ? null
      : 'Add WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN and WHATSAPP_OWNER_NUMBER to enable approvals over WhatsApp.',
  };
}

const HELP_TEXT = [
  'PostPilot approvals',
  '',
  'Send the code from your approval email (example: APR-K7M2QX) to see the post and decide.',
  'You can also reply APPROVE or REJECT with the code, e.g. "approve APR-K7M2QX".',
  '',
  'Nothing is published without your reply.',
].join('\n');

function trim(text: string, limit = TEXT_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function previewBody(post: { runDate: string; fullText: string; hashtags: string[] }): string {
  const tags = post.hashtags.length ? `\n\n${post.hashtags.map((tag) => `#${tag}`).join(' ')}` : '';
  return trim(`*${post.runDate} · LinkedIn draft*\n\n${post.fullText}${tags}`);
}

function decisionSummary(outcome: Awaited<ReturnType<typeof decideApproval>>): string {
  const published = outcome.publish?.status === 'published';
  if (outcome.approval.status === 'rejected') {
    return 'Rejected ❌ — nothing was published for this post.';
  }
  if (published) {
    return `Published ✅${outcome.publish?.url ? `\n${outcome.publish.url}` : ''}`;
  }
  const detail = outcome.publish?.message ? `\n${outcome.publish.message}` : '';
  return `Approved ✅ — publishing is queued.${detail}`;
}

async function reply(services: Services, to: string, body: string): Promise<void> {
  try {
    await services.whatsapp.sendText(to, body);
    await createLogger(services.db, { actor: 'whatsapp' }).info(
      'whatsapp.reply_sent',
      'WhatsApp reply delivered',
      { to: maskPhone(to) },
    );
  } catch (error) {
    await createLogger(services.db, { actor: 'whatsapp' }).warn(
      'whatsapp.reply_failed',
      'WhatsApp reply failed',
      { error: safeErrorMessage(error) },
    );
  }
}

async function handleCode(services: Services, to: string, code: string): Promise<InboundOutcome> {
  const log = createLogger(services.db, { actor: 'whatsapp' });
  const record = await services.db.getWhatsAppCode(
    await hashApprovalToken(code, services.config.auth.approvalTokenSecret),
  );

  if (!record) {
    await reply(
      services,
      to,
      'That code is not valid. Open the latest approval email and send the new code.',
    );
    return { handled: true, reason: 'unknown_code' };
  }
  if (record.usedAt) {
    await reply(services, to, 'That code was already used. Each code works once.');
    return { handled: true, reason: 'code_used' };
  }
  if (new Date(record.expiresAt).getTime() <= services.clock.now().getTime()) {
    await reply(services, to, 'That code expired. A fresh one is in the next approval email.');
    return { handled: true, reason: 'code_expired' };
  }

  const post = await services.db.getPost(record.postId);
  if (!post) {
    await reply(services, to, 'That post no longer exists.');
    return { handled: true, reason: 'post_missing' };
  }
  if (post.status === 'published') {
    await reply(services, to, `This post is already live.\n${post.publishedUrl ?? ''}`.trim());
    return { handled: true, reason: 'already_published' };
  }
  if (post.status !== 'pending_approval' && post.status !== 'approved') {
    await reply(
      services,
      to,
      `This post is "${post.status.replace(/_/g, ' ')}", so it needs no action.`,
    );
    return { handled: true, reason: 'wrong_status' };
  }

  await reply(services, to, previewBody(post));
  try {
    await services.whatsapp.sendButtons(to, 'Approve this post?', [
      { id: `approve:${code}`, title: '✅ Approve' },
      { id: `reject:${code}`, title: '❌ Reject' },
    ]);
    await log.info('whatsapp.preview_sent', 'Approval preview sent on WhatsApp', {
      postId: post.id,
    });
  } catch (error) {
    await log.warn('whatsapp.preview_failed', 'Could not send approval buttons', {
      postId: post.id,
      error: safeErrorMessage(error),
    });
    await reply(services, to, `Reply "approve ${code}" or "reject ${code}".`);
  }
  return { handled: true, reason: 'preview_sent' };
}

async function handleDecision(
  services: Services,
  to: string,
  action: 'approve' | 'reject',
  code: string,
): Promise<InboundOutcome> {
  const log = createLogger(services.db, { actor: 'whatsapp' });
  const codeHash = await hashApprovalToken(code, services.config.auth.approvalTokenSecret);
  const consumed = await services.db.consumeWhatsAppCode(codeHash);
  if (!consumed) {
    await reply(
      services,
      to,
      'That code cannot be used (already used or expired). Check the latest approval email.',
    );
    return { handled: true, reason: 'code_unusable' };
  }

  try {
    const outcome = await decideApproval(services, {
      action,
      actor: 'whatsapp',
      postId: consumed.postId,
    });
    await log.info(
      `approval.${action === 'approve' ? 'approved' : 'rejected'}`,
      `Approval ${action}d over WhatsApp`,
      {
        postId: consumed.postId,
        channel: 'whatsapp',
      },
    );
    await reply(services, to, decisionSummary(outcome));
    return { handled: true, reason: `decision_${action}` };
  } catch (error) {
    await log.error('whatsapp.decision_failed', 'WhatsApp decision failed', {
      postId: consumed.postId,
      action,
      error: safeErrorMessage(error),
    });
    await reply(services, to, `Could not apply that: ${safeErrorMessage(error)}`);
    return { handled: true, reason: 'decision_failed' };
  }
}

/** Handles a single inbound message; never throws, so one bad event cannot break the batch. */
export async function handleInbound(
  services: Services,
  inbound: WhatsAppInbound,
): Promise<InboundOutcome> {
  const log = createLogger(services.db, { actor: 'whatsapp' });
  const owner = normalizePhone(services.config.whatsapp.ownerNumber);
  const to = normalizePhone(inbound.from);

  if (!owner || to !== owner) {
    await log.warn('whatsapp.sender_rejected', 'Ignored WhatsApp message from a non-owner number', {
      from: maskPhone(to),
    });
    return { handled: false, reason: 'not_owner' };
  }

  const fresh = await services.db.recordWhatsAppMessage({
    messageId: inbound.messageId,
    from: to,
    receivedAt: inbound.timestamp,
  });
  if (!fresh) {
    await log.debug('whatsapp.duplicate', 'Ignored duplicated WhatsApp webhook delivery', {
      messageId: inbound.messageId,
    });
    return { handled: false, reason: 'duplicate' };
  }

  await services.whatsapp.markRead(inbound.messageId).catch(() => undefined);
  await log.info('whatsapp.inbound', 'WhatsApp message received', {
    kind: inbound.kind,
  });

  if (inbound.kind === 'reply') {
    const [rawAction, rawCode] = (inbound.text ?? '').split(':');
    const action = rawAction === 'approve' ? 'approve' : rawAction === 'reject' ? 'reject' : null;
    const code = normalizeApprovalCode(rawCode);
    if (!action || !code) {
      await reply(
        services,
        to,
        'That button is out of date. Open the latest approval email for a new code.',
      );
      return { handled: true, reason: 'stale_button' };
    }
    return handleDecision(services, to, action, code);
  }

  const text = (inbound.text ?? '').trim();
  const code = normalizeApprovalCode(text);
  if (!code) {
    await reply(services, to, HELP_TEXT);
    return { handled: true, reason: 'help' };
  }

  const lowered = text.toLowerCase();
  if (/\b(reject|decline|no)\b/.test(lowered)) return handleDecision(services, to, 'reject', code);
  if (/\b(approve|approve[d]?|ok|yes)\b/.test(lowered)) {
    return handleDecision(services, to, 'approve', code);
  }
  return handleCode(services, to, code);
}

/** Verifies the Meta signature, then processes every message in the webhook batch. */
export async function handleWebhook(
  services: Services,
  input: { rawBody: string; signature: string | null; payload: unknown },
): Promise<WebhookResult> {
  if (!services.config.whatsapp.enabled) {
    return { ok: false, status: 503, processed: 0, reason: 'whatsapp_disabled' };
  }

  const log = createLogger(services.db, { actor: 'whatsapp' });
  const verified = await services.whatsapp.verifySignature(input.rawBody, input.signature);
  if (!verified) {
    await log.warn('whatsapp.signature_invalid', 'Rejected WhatsApp webhook with a bad signature');
    return { ok: false, status: 401, processed: 0, reason: 'invalid_signature' };
  }

  const events = services.whatsapp.parseInbound(input.payload);
  let processed = 0;
  for (const event of events) {
    try {
      const outcome = await handleInbound(services, event);
      if (outcome.handled) processed += 1;
    } catch (error) {
      await log.error('whatsapp.event_failed', 'WhatsApp event handling failed', {
        error: safeErrorMessage(error),
      });
    }
  }
  return { ok: true, status: 200, processed };
}

/** Constant-time-ish hex compare used by adapters when checking the HMAC signature. */
export function hexEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export function decodeSignature(header: string | null): string | null {
  if (!header) return null;
  const value = header.startsWith('sha256=') ? header.slice(7) : header;
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}
