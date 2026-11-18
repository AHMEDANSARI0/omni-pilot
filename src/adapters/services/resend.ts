import { AppError, safeErrorMessage } from '@/src/core/errors';
import type { EmailGateway, EmailMessage } from '@/src/core/ports';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendOptions {
  apiKey: string | null;
  fromEmail: string;
  fetchImpl?: typeof fetch;
}

/** Resend email gateway (free tier: 100 emails/day, 3000/month). */
export class ResendEmailGateway implements EmailGateway {
  private readonly apiKey: string | null;
  private readonly fromEmail: string;
  private readonly http: typeof fetch;

  constructor(options: ResendOptions) {
    this.apiKey = options.apiKey;
    this.fromEmail = options.fromEmail;
    this.http = options.fetchImpl ?? fetch;
  }

  describe(): Promise<{ connected: boolean; fromEmail: string }> {
    return Promise.resolve({ connected: Boolean(this.apiKey), fromEmail: this.fromEmail });
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    if (!this.apiKey) {
      throw new AppError(
        'EMAIL_ERROR',
        'RESEND_API_KEY is not configured, so approval emails cannot be sent.',
        { retryable: false },
      );
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.http(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: this.fromEmail,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: AbortSignal.timeout(20_000),
        });

        if (response.ok) {
          const payload = (await response.json()) as { id?: string };
          if (!payload.id) throw new AppError('EMAIL_ERROR', 'Resend returned no message id');
          return { messageId: payload.id };
        }

        const text = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        const hint =
          response.status === 401 || response.status === 403
            ? ' Check RESEND_API_KEY and that RESEND_FROM_EMAIL is a verified domain (or use onboarding@resend.dev for your own account email).'
            : '';
        const error = new AppError(
          'EMAIL_ERROR',
          `Resend rejected the email (HTTP ${response.status}): ${safeErrorMessage(text).slice(0, 300)}.${hint}`,
          { retryable, details: { status: response.status } },
        );
        if (retryable && attempt < 2) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof AppError) throw error;
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }
      }
    }
    throw new AppError('EMAIL_ERROR', `Resend send failed: ${safeErrorMessage(lastError)}`, {
      retryable: true,
      cause: lastError,
    });
  }
}
