import { describe, expect, it } from 'vitest';
import { CloudWhatsAppGateway } from '@/src/adapters/services/whatsapp-cloud';
import { DisabledWhatsAppGateway } from '@/src/adapters/services/whatsapp';
import { generateDailyPost } from '@/src/core/generation';
import { hashApprovalToken } from '@/src/core/tokens';
import type { WhatsAppInbound } from '@/src/core/ports';
import {
  buildApprovalLink,
  handleInbound,
  handleWebhook,
  maskPhone,
  normalizeApprovalCode,
  whatsappStatus,
} from '@/src/core/whatsapp';
import { createApp } from '@/src/worker/app';
import { createHarness, testConfig, TEST_WHATSAPP_ENV, type Harness } from './helpers';

const OWNER = '923001234567';
const APP_SECRET = TEST_WHATSAPP_ENV.WHATSAPP_APP_SECRET;

function codeFromEmail(harness: Harness): string {
  const email = harness.email.sent.find((message) => message.html.includes('wa.me/'));
  if (!email) throw new Error('No WhatsApp link in the approval email');
  const match = email.html.match(/wa\.me\/(\d+)\?text=(APR-[A-Z0-9]{6})/);
  if (!match) throw new Error('WhatsApp link is malformed');
  expect(match[1]).toBe(OWNER);
  return match[2]!;
}

async function webhook(
  harness: Harness,
  events: Array<{ id: string; text?: string; buttonId?: string; from?: string; at?: string }>,
  options: { signature?: string | null } = {},
) {
  const payload: WhatsAppInbound[] = events.map((event) => ({
    kind: event.buttonId ? ('reply' as const) : ('text' as const),
    messageId: event.id,
    from: event.from ?? OWNER,
    text: event.buttonId ?? event.text ?? null,
    timestamp: event.at ?? '2026-11-16T05:10:00.000Z',
  }));
  const rawBody = JSON.stringify(payload);
  const signature =
    options.signature === undefined
      ? `sha256=${await hashApprovalToken(rawBody, APP_SECRET)}`
      : options.signature;

  // The fake gateway has no JSON parser of its own; it drains the queue we hand it.
  harness.whatsapp.queue = payload;
  return handleWebhook(harness.services, { rawBody, signature, payload });
}

describe('whatsapp approval channel', () => {
  it('normalises short codes and phone numbers', () => {
    expect(normalizeApprovalCode('APR-K7M2QX')).toBe('APR-K7M2QX');
    expect(normalizeApprovalCode('apr k7m2qx')).toBe('APR-K7M2QX');
    expect(normalizeApprovalCode('please approve APR-K7M2QX now')).toBe('APR-K7M2QX');
    expect(normalizeApprovalCode('K7M2QX')).toBeNull(); // the APR- prefix is always required
    expect(normalizeApprovalCode('apr-k7m2qx')).toBe('APR-K7M2QX');
    expect(normalizeApprovalCode('APR-111111')).toBeNull();
    expect(normalizeApprovalCode('')).toBeNull();
    expect(maskPhone('+92 300 1234567')).toBe('+•••• 4567');
    expect(maskPhone('12')).toBeNull();
    expect(buildApprovalLink('+92 (300) 1234567', 'APR-K7M2QX')).toBe(
      `https://wa.me/${OWNER}?text=APR-K7M2QX`,
    );
  });

  it('adds a free wa.me link with a short code to the approval email', async () => {
    const harness = createHarness({ whatsapp: true });
    const result = await generateDailyPost(harness.services, { trigger: 'test' });
    expect(result.status).toBe('generated');

    const code = codeFromEmail(harness);
    expect(code).toMatch(/^APR-[A-HJ-NP-Z2-9]{6}$/);
    const email = harness.email.sent.find((message) => message.html.includes('wa.me/'))!;
    expect(email.html).toContain('Approve on WhatsApp');
    expect(email.text).toContain('Approve on WhatsApp:');

    const stored = await harness.db.getWhatsAppCode(
      await hashApprovalToken(code, harness.config.auth.approvalTokenSecret),
    );
    expect(stored?.usedAt).toBeNull();
  });

  it('sends the post and approve/reject buttons when the owner sends the code', async () => {
    const harness = createHarness({ whatsapp: true });
    await generateDailyPost(harness.services, { trigger: 'test' });
    const code = codeFromEmail(harness);
    harness.whatsapp.sent = [];

    const result = await webhook(harness, [{ id: 'wamid.1', text: code }]);

    expect(result).toMatchObject({ ok: true, status: 200, processed: 1 });
    expect(harness.whatsapp.readIds).toContain('wamid.1');
    expect(harness.whatsapp.sent).toHaveLength(2);
    expect(harness.whatsapp.sent[0]?.kind).toBe('text');
    expect(harness.whatsapp.sent[0]?.body).toContain('LinkedIn draft');
    expect(harness.whatsapp.sent[1]?.buttons).toEqual([
      { id: `approve:${code}`, title: '✅ Approve' },
      { id: `reject:${code}`, title: '❌ Reject' },
    ]);
  });

  it('publishes on an approve button tap and burns the code', async () => {
    // 10:05 PKT: past the 09:30 publish slot, so approval publishes immediately.
    const harness = createHarness({ whatsapp: true, now: '2026-11-16T05:05:00Z' });
    await generateDailyPost(harness.services, { trigger: 'test' });
    const code = codeFromEmail(harness);
    harness.whatsapp.sent = [];

    const result = await webhook(harness, [{ id: 'wamid.2', buttonId: `approve:${code}` }]);

    expect(result.processed).toBe(1);
    expect(harness.linkedin.publishCalls).toHaveLength(1);
    const posts = harness.db.allPosts();
    expect(posts[0]?.status).toBe('published');
    const reply = harness.whatsapp.sent.at(-1)!;
    expect(reply.body).toContain('Published');
    expect(reply.body).toContain('linkedin.com');

    // Replaying the same code is refused and publishes nothing new.
    await webhook(harness, [{ id: 'wamid.3', buttonId: `approve:${code}` }]);
    expect(harness.linkedin.publishCalls).toHaveLength(1);
    expect(harness.whatsapp.sent.at(-1)?.body).toContain('cannot be used');
  });

  it('rejects without publishing', async () => {
    const harness = createHarness({ whatsapp: true });
    await generateDailyPost(harness.services, { trigger: 'test' });
    const code = codeFromEmail(harness);
    harness.whatsapp.sent = [];

    await webhook(harness, [{ id: 'wamid.4', text: `reject ${code.toLowerCase()}` }]);

    expect(harness.linkedin.publishCalls).toHaveLength(0);
    expect(harness.db.allPosts()[0]?.status).toBe('rejected');
    expect(harness.whatsapp.sent.at(-1)?.body).toContain('Rejected');
  });

  it('ignores duplicate deliveries, unknown senders and unsigned calls', async () => {
    const harness = createHarness({ whatsapp: true });
    await generateDailyPost(harness.services, { trigger: 'test' });
    const code = codeFromEmail(harness);

    const badSignature = await webhook(harness, [{ id: 'wamid.5', text: code }], {
      signature: 'sha256=deadbeef',
    });
    expect(badSignature).toMatchObject({ ok: false, status: 401 });

    const missingSignature = await webhook(harness, [{ id: 'wamid.5', text: code }], {
      signature: null,
    });
    expect(missingSignature.status).toBe(401);

    const stranger = await webhook(harness, [{ id: 'wamid.6', text: code, from: '923009999999' }]);
    expect(stranger.processed).toBe(0);

    harness.whatsapp.sent = [];
    await webhook(harness, [{ id: 'wamid.7', text: code }]);
    const repeated = await webhook(harness, [{ id: 'wamid.7', text: code }]);
    expect(repeated.processed).toBe(0);
    expect(harness.whatsapp.sent).toHaveLength(2);
  });

  it('explains expired codes and stale buttons instead of failing silently', async () => {
    const harness = createHarness({ whatsapp: true });
    await generateDailyPost(harness.services, { trigger: 'test' });
    const code = codeFromEmail(harness);
    harness.clock.advanceMinutes(13 * 60);
    harness.whatsapp.sent = [];

    await webhook(harness, [{ id: 'wamid.8', text: code }]);
    expect(harness.whatsapp.sent.at(-1)?.body).toContain('expired');

    await webhook(harness, [{ id: 'wamid.9', buttonId: 'approve:APR-XXXXX' }]);
    expect(harness.whatsapp.sent.at(-1)?.body).toContain('out of date');
  });

  it('replies with help when no code is present', async () => {
    const harness = createHarness({ whatsapp: true });
    harness.whatsapp.sent = [];
    const result = await handleInbound(harness.services, {
      kind: 'text',
      messageId: 'wamid.10',
      from: OWNER,
      text: 'hello',
      timestamp: '2026-11-16T05:10:00.000Z',
    });
    expect(result).toMatchObject({ handled: true, reason: 'help' });
    expect(harness.whatsapp.sent[0]?.body).toContain('PostPilot approvals');
  });

  it('refuses webhooks while the channel is disabled, and reports status honestly', async () => {
    const harness = createHarness();
    const result = await handleWebhook(harness.services, {
      rawBody: '{}',
      signature: 'sha256=abc',
      payload: {},
    });
    expect(result).toMatchObject({ ok: false, status: 503 });

    const status = whatsappStatus(harness.services);
    expect(status.connected).toBe(false);
    expect(status.reason).toContain('WHATSAPP_PHONE_NUMBER_ID');

    const disabled = new DisabledWhatsAppGateway();
    await expect(disabled.sendText('1', 'x')).rejects.toThrow('not configured');
    expect(disabled.parseInbound()).toEqual([]);
  });
});

describe('Cloud WhatsApp adapter', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: 'wamid.A',
                  from: '923001234567',
                  timestamp: '1763266200',
                  type: 'text',
                  text: { body: 'APR-K7M2QX' },
                },
                {
                  id: 'wamid.B',
                  from: '923001234567',
                  timestamp: '1763266201',
                  type: 'interactive',
                  interactive: { type: 'button_reply', button_reply: { id: 'approve:APR-K7M2QX' } },
                },
                { id: 'wamid.C', from: '923001234567', type: 'image', image: { id: '1' } },
              ],
              statuses: [{ id: 'wamid.status', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };

  function gateway(fetchImpl: typeof fetch, appSecret: string | null = APP_SECRET) {
    return new CloudWhatsAppGateway({
      phoneNumberId: '1234567890',
      accessToken: 'token-123',
      appSecret,
      ownerNumber: OWNER,
      apiVersion: 'v21.0',
      fetchImpl,
    });
  }

  function captureFetch(response: { status: number; body: unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it('parses text and button replies but ignores statuses', () => {
    const events = gateway(fetch).parseInbound(payload);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'text', text: 'APR-K7M2QX', from: OWNER });
    expect(events[1]).toMatchObject({ kind: 'reply', text: 'approve:APR-K7M2QX' });
    expect(gateway(fetch).parseInbound({})).toEqual([]);
  });

  it('verifies the Meta HMAC signature', async () => {
    const raw = JSON.stringify(payload);
    const valid = `sha256=${await hashApprovalToken(raw, APP_SECRET)}`;
    await expect(gateway(fetch).verifySignature(raw, valid)).resolves.toBe(true);
    await expect(gateway(fetch).verifySignature(raw, 'sha256=00')).resolves.toBe(false);
    await expect(gateway(fetch).verifySignature(raw, null)).resolves.toBe(false);
    await expect(gateway(fetch, null).verifySignature(raw, valid)).resolves.toBe(false);
  });

  it('sends messages to the Graph API with the bearer token', async () => {
    const { calls, impl } = captureFetch({
      status: 200,
      body: { messages: [{ id: 'wamid.out' }] },
    });
    const client = gateway(impl);

    const text = await client.sendText(OWNER, 'hello');
    expect(text.messageId).toBe('wamid.out');
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-123',
    );

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      to: OWNER,
      type: 'text',
      text: { body: 'hello' },
    });

    await client.sendButtons(OWNER, 'Approve?', [{ id: 'approve:APR-1', title: '✅ Approve' }]);
    const interactive = JSON.parse(String(calls[1]?.init.body));
    expect(interactive.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: 'approve:APR-1', title: '✅ Approve' } },
    ]);
  });

  it('surfaces Meta errors without retrying permanent failures', async () => {
    const { calls, impl } = captureFetch({
      status: 400,
      body: { error: { message: 'Recipient phone number not in allowed list', code: 131030 } },
    });
    await expect(gateway(impl).sendText(OWNER, 'hi')).rejects.toThrow(
      'Recipient phone number not in allowed list',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('whatsapp webhook routes', () => {
  const BASE = 'http://automation.test';

  function appFor(harness: Harness, services = harness.services) {
    return createApp({ serviceFactory: async () => services });
  }

  it('answers the Meta verification handshake only with the right token', async () => {
    const harness = createHarness({ whatsapp: true });
    const app = appFor(harness);

    const good = await app.fetch(
      new Request(
        `${BASE}/api/v1/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-123`,
      ),
      harness.env as Record<string, string>,
    );
    expect(good.status).toBe(200);
    expect(await good.text()).toBe('challenge-123');

    const bad = await app.fetch(
      new Request(
        `${BASE}/api/v1/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=x`,
      ),
      harness.env as Record<string, string>,
    );
    expect(bad.status).toBe(403);
  });

  it('processes a signed webhook and rejects unsigned calls', async () => {
    const harness = createHarness({ whatsapp: true });
    await generateDailyPost(harness.services, { trigger: 'test' });
    const code = codeFromEmail(harness);
    const app = appFor(harness);

    const events: WhatsAppInbound[] = [
      {
        kind: 'text',
        messageId: 'wamid.api.1',
        from: OWNER,
        text: code,
        timestamp: '2026-11-16T05:10:00.000Z',
      },
    ];
    const rawBody = JSON.stringify(events);
    harness.whatsapp.queue = [...events];
    const signature = `sha256=${await hashApprovalToken(rawBody, APP_SECRET)}`;

    const unsigned = await app.fetch(
      new Request(`${BASE}/api/v1/integrations/whatsapp/webhook`, {
        method: 'POST',
        body: rawBody,
        headers: { 'Content-Type': 'application/json' },
      }),
      harness.env as Record<string, string>,
    );
    expect(unsigned.status).toBe(401);

    const signed = await app.fetch(
      new Request(`${BASE}/api/v1/integrations/whatsapp/webhook`, {
        method: 'POST',
        body: rawBody,
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
      }),
      harness.env as Record<string, string>,
    );
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ ok: true, processed: 1 });
  });

  it('keeps the owner status and test endpoints behind auth', async () => {
    const harness = createHarness({ whatsapp: true });
    const app = appFor(harness);

    const status = await app.fetch(
      new Request(`${BASE}/api/v1/whatsapp/status`),
      harness.env as Record<string, string>,
    );
    expect(status.status).toBe(200);
    const body = (await status.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      connected: true,
      mode: 'cloud',
      number: '+•••• 4567',
      webhookUrl: 'https://automation.test/api/v1/integrations/whatsapp/webhook',
      verifyTokenSet: true,
      appSecretSet: true,
    });

    const sent = await app.fetch(
      new Request(`${BASE}/api/v1/whatsapp/test`, { method: 'POST' }),
      harness.env as Record<string, string>,
    );
    expect(sent.status).toBe(200);
    expect(harness.whatsapp.sent.at(-1)?.body).toContain('PostPilot is connected');

    const lockedHarness = createHarness({ whatsapp: true });
    const locked = appFor(lockedHarness, {
      ...lockedHarness.services,
      config: testConfig({ ...TEST_WHATSAPP_ENV, ALLOW_DEV_BYPASS: '' }),
    });
    const unauthorized = await locked.fetch(
      new Request(`${BASE}/api/v1/whatsapp/status`),
      lockedHarness.env as Record<string, string>,
    );
    expect(unauthorized.status).toBe(401);
  });
});
