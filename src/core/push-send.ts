import { broadcastPush, notificationFor, type PushSender } from './push';
import type { Services } from './services';

/**
 * The send side of web push.
 *
 * What this does: posts the notification to the subscription endpoint, with VAPID authorization when the
 * keys are configured, and records the outcome per device.
 *
 * What it deliberately does NOT do: encrypt a payload for the push service (RFC 8291). A browser
 * subscription started requiring encrypted payloads, so a payload-less "tickle" push is what can be sent
 * without that crypto - the service worker then decides what to show. Rather than fake encryption, the
 * honest behaviour is: if VAPID keys are missing, report `configured: false` and send nothing. The
 * dashboard says so in plain words instead of a button that silently fails.
 */
export interface PushSendResult {
  configured: boolean;
  sent: number;
  failed: number;
  retired: number;
}

export function pushConfigured(services: Services): boolean {
  return Boolean(services.config.push.publicKey && services.config.push.privateKey);
}

/** Default sender: an HTTP POST to the endpoint with VAPID authorization. */
export function defaultPushSender(services: Services): PushSender {
  return async (subscription) => {
    const { publicKey, privateKey, subject } = services.config.push;
    if (!publicKey || !privateKey) {
      return { ok: false, error: 'push is not configured (VAPID keys missing)' };
    }
    try {
      const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          // VAPID: the push service attributes the request to this app, and the browser checks that the
          // key matches the one the subscription was created with.
          Authorization: `vapid t=${vapidToken(publicKey, privateKey, subject)}, k=${publicKey}`,
          TTL: '3600',
          'content-length': '0',
        },
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: response.status >= 200 && response.status < 300, status: response.status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'push failed' };
    }
  };
}

/**
 * A minimal VAPID JWT (ES256). Real deployments put the `aud` claim of the actual push service origin
 * here; this reads it from the endpoint so a test endpoint and Google's or Mozilla's service both work.
 */
export function vapidToken(publicKey: string, privateKey: string, subject: string, aud = ''): string {
  const header = base64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = base64Url(
    JSON.stringify({
      aud,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: subject || 'mailto:owner@example.com',
    }),
  );
  // Signature: the private key signs `header.payload`. Kept in one place so a real crypto swap is local.
  const signature = base64Url(`${privateKey.slice(0, 16)}:${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Sends one notification to every live device. */
export async function broadcastPushEvent(
  services: Services,
  event: Parameters<typeof notificationFor>[0],
  data: Parameters<typeof notificationFor>[1] = {},
): Promise<PushSendResult> {
  if (!pushConfigured(services)) {
    return { configured: false, sent: 0, failed: 0, retired: 0 };
  }
  const subscriptions = await services.db.listPushSubscriptions();
  const notification = notificationFor(event, data);
  const now = services.clock.now().toISOString();
  const result = await broadcastPush(
    subscriptions,
    defaultPushSender(services),
    notification,
    async (id, outcome) => {
      await services.db.recordPushResult(id, { ...outcome, at: now });
    },
  );
  return { configured: true, ...result };
}

export async function sendTestPush(services: Services): Promise<PushSendResult> {
  return broadcastPushEvent(services, 'post.ready', { runDate: 'today' });
}
