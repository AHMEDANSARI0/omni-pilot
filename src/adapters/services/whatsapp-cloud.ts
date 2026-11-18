import { AppError, safeErrorMessage } from '@/src/core/errors';
import { hexEquals, decodeSignature } from '@/src/core/whatsapp';
import { maskPhone } from '@/src/core/whatsapp';
import { hashApprovalToken } from '@/src/core/tokens';
import type { WhatsAppGateway, WhatsAppInbound, WhatsAppStatus } from '@/src/core/ports';

const GRAPH_BASE = 'https://graph.facebook.com';
const TEXT_LIMIT = 3_500;
const BUTTON_LIMIT = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export interface CloudWhatsAppOptions {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string | null;
  ownerNumber: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

interface GraphMessageResponse {
  messages?: Array<{ id?: string }>;
  error?: { message?: string; code?: number };
}

/**
 * Official WhatsApp Cloud API (Meta). Free to use: inbound messages and replies inside the
 * 24 h customer-service window are not billed, and templates are never sent.
 */
export class CloudWhatsAppGateway implements WhatsAppGateway {
  readonly id = 'whatsapp-cloud';
  private readonly http: typeof fetch;

  constructor(private readonly options: CloudWhatsAppOptions) {
    this.http = options.fetchImpl ?? fetch;
  }

  describe(): Promise<WhatsAppStatus> {
    return Promise.resolve({
      connected: true,
      number: maskPhone(this.options.ownerNumber),
      mode: 'cloud',
      reason: null,
    });
  }

  /** Meta signs every webhook body with HMAC-SHA256(app secret). */
  async verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
    const received = decodeSignature(signatureHeader);
    if (!received || !this.options.appSecret) return false;
    const expected = await hashApprovalToken(rawBody, this.options.appSecret);
    return hexEquals(expected, received);
  }

  parseInbound(payload: unknown): WhatsAppInbound[] {
    const events: WhatsAppInbound[] = [];
    const entries = asArray((payload as { entry?: unknown })?.entry);
    for (const entry of entries) {
      for (const change of asArray((entry as { changes?: unknown })?.changes)) {
        const value = (change as { value?: { messages?: unknown } })?.value;
        for (const raw of asArray(value?.messages)) {
          const message = raw as {
            id?: string;
            from?: string;
            timestamp?: string;
            type?: string;
            text?: { body?: string };
            interactive?: { type?: string; button_reply?: { id?: string } };
          };
          const messageId = String(message.id ?? '');
          const from = String(message.from ?? '');
          if (!messageId || !from) continue;
          const timestamp = message.timestamp
            ? new Date(Number(message.timestamp) * 1_000).toISOString()
            : new Date().toISOString();

          if (message.type === 'text' && typeof message.text?.body === 'string') {
            events.push({ kind: 'text', messageId, from, text: message.text.body, timestamp });
          } else if (
            message.type === 'interactive' &&
            message.interactive?.type === 'button_reply' &&
            message.interactive.button_reply?.id
          ) {
            events.push({
              kind: 'reply',
              messageId,
              from,
              text: message.interactive.button_reply.id,
              timestamp,
            });
          }
        }
      }
    }
    return events;
  }

  async sendText(to: string, body: string): Promise<{ messageId: string }> {
    return this.send(to, {
      type: 'text',
      text: { preview_url: false, body: trim(body) },
    });
  }

  async sendButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<{ messageId: string }> {
    const replies = buttons.slice(0, BUTTON_LIMIT).map((button) => ({
      type: 'reply' as const,
      reply: { id: button.id.slice(0, 256), title: button.title.slice(0, 20) },
    }));
    return this.send(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: trim(body) },
        action: { buttons: replies },
      },
    });
  }

  async markRead(messageId: string): Promise<void> {
    await this.request({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }).catch(() => undefined);
  }

  private async send(to: string, payload: Record<string, unknown>) {
    const response = await this.request({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      ...payload,
    });
    const messageId = response.messages?.[0]?.id;
    if (!messageId) {
      throw new AppError(
        'WHATSAPP_ERROR',
        'WhatsApp accepted the request but returned no message id.',
      );
    }
    return { messageId };
  }

  private async request(payload: Record<string, unknown>): Promise<GraphMessageResponse> {
    const url = `${GRAPH_BASE}/${this.options.apiVersion}/${this.options.phoneNumberId}/messages`;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.http(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const json = (await response.json().catch(() => null)) as GraphMessageResponse | null;
        if (response.ok) return json ?? {};

        const message = json?.error?.message ?? `WhatsApp API responded with ${response.status}`;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 2) {
          throw new AppError('WHATSAPP_ERROR', message, {
            retryable,
            details: { status: response.status, code: json?.error?.code ?? null },
          });
        }
        lastError = new AppError('WHATSAPP_ERROR', message, { retryable: true });
      } catch (error) {
        if (error instanceof AppError && !error.retryable) throw error;
        lastError = error;
        if (attempt === 2) break;
      }
    }

    throw new AppError(
      'WHATSAPP_ERROR',
      `WhatsApp request failed: ${safeErrorMessage(lastError)}`,
      {
        retryable: true,
        cause: lastError,
      },
    );
  }
}

function trim(text: string): string {
  return text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT - 1)}…`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
