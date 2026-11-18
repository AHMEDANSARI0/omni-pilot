import { AppError } from '@/src/core/errors';
import type { WhatsAppGateway, WhatsAppInbound, WhatsAppStatus } from '@/src/core/ports';

/** Used whenever the Cloud API credentials are missing: approvals stay email/web only. */
export class DisabledWhatsAppGateway implements WhatsAppGateway {
  readonly id = 'whatsapp-disabled';

  describe(): Promise<WhatsAppStatus> {
    return Promise.resolve({
      connected: false,
      number: null,
      mode: 'disabled',
      reason:
        'Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN and WHATSAPP_OWNER_NUMBER to approve posts over WhatsApp.',
    });
  }

  verifySignature(_rawBody: string, _signatureHeader: string | null): Promise<boolean> {
    return Promise.resolve(false);
  }

  parseInbound(_payload?: unknown): WhatsAppInbound[] {
    return [];
  }

  sendText(_to: string, _body: string): Promise<{ messageId: string }> {
    return Promise.reject(this.error());
  }

  sendButtons(
    _to: string,
    _body: string,
    _buttons: Array<{ id: string; title: string }>,
  ): Promise<{ messageId: string }> {
    return Promise.reject(this.error());
  }

  markRead(_messageId: string): Promise<void> {
    return Promise.resolve();
  }

  private error(): AppError {
    return new AppError('WHATSAPP_ERROR', 'WhatsApp is not configured.', { retryable: false });
  }
}
