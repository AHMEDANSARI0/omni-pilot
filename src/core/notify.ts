import { buildFailureEmail } from './emails';
import { safeErrorMessage } from './errors';
import type { Logger } from './logger';
import type { EmailMessage } from './ports';
import type { Services } from './services';

export interface SendResult {
  sent: boolean;
  messageId: string | null;
  error: string | null;
}

/**
 * Owner-facing email. Failures are logged and returned, never thrown, so a broken email
 * provider cannot stop content generation or publishing bookkeeping.
 */
export async function sendOwnerEmail(
  services: Services,
  log: Logger,
  message: Omit<EmailMessage, 'to'> & { to?: string },
  options: { respectEmailSetting?: boolean } = {},
): Promise<SendResult> {
  const settings = await services.db.getSettings();
  if (options.respectEmailSetting !== false && !settings.emailNotifications) {
    await log.info('email.skipped', 'Email notifications are disabled in settings', {
      subject: message.subject,
    });
    return { sent: false, messageId: null, error: 'Email notifications disabled in settings' };
  }

  try {
    const result = await services.email.send({
      to: message.to ?? services.config.ownerEmail,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    await log.info('email.sent', message.subject, { messageId: result.messageId });
    return { sent: true, messageId: result.messageId, error: null };
  } catch (error) {
    const reason = safeErrorMessage(error);
    await log.error('email.failed', `Email delivery failed: ${reason}`, {
      subject: message.subject,
    });
    return { sent: false, messageId: null, error: reason };
  }
}

export async function notifyFailure(
  services: Services,
  log: Logger,
  input: { runDate: string; stage: string; message: string },
): Promise<void> {
  const settings = await services.db.getSettings();
  await sendOwnerEmail(
    services,
    log,
    buildFailureEmail({
      runDate: input.runDate,
      stage: input.stage,
      message: input.message,
      settings,
      dashboardUrl: `${services.config.baseUrl}/`,
    }),
  );
}
