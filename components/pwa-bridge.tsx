'use client';

import { useEffect, useState } from 'react';

/**
 * Registers the service worker and offers web push.
 *
 * The button only appears when the browser can actually do it - no push UI on iOS Safari in a tab, no
 * button in an insecure context - and it explains the one thing the owner needs to know: notifications
 * arrive when a draft is ready or a post fails, not for everything.
 *
 * Permission is requested on click, never on load. A permission prompt nobody asked for is the fastest
 * way to get permanently blocked.
 */
interface PushState {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  busy: boolean;
  message: string | null;
}

export function PwaBridge({ publicKey: providedKey = null }: { publicKey?: string | null } = {}) {
  // The key is public, so the component can fetch it itself and the page does not have to know that
  // push exists. A page that passes it skips the request.
  const [publicKey, setPublicKey] = useState<string | null>(providedKey);
  const [state, setState] = useState<PushState>({
    supported: false,
    permission: 'unsupported',
    subscribed: false,
    busy: false,
    message: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (typeof window === 'undefined') return;
      const supported =
        'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

      // Register regardless of push support: the cache-first shell is useful on its own.
      if ('serviceWorker' in navigator) {
        try {
          await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        } catch {
          // A failed registration must not break the dashboard.
        }
      }

      let subscribed = false;
      if (supported) {
        const registration = await navigator.serviceWorker.ready.catch(() => null);
        const existing = await registration?.pushManager.getSubscription().catch(() => null);
        subscribed = Boolean(existing);
      }
      if (!cancelled) {
        setState({
          supported,
          permission: supported ? Notification.permission : 'unsupported',
          subscribed,
          busy: false,
          message: null,
        });
      }
    }

    if (!providedKey) {
      void fetch('/api/v1/push/public-key')
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { data?: { publicKey?: string | null } } | null) => {
          if (!cancelled) setPublicKey(body?.data?.publicKey ?? null);
        })
        .catch(() => undefined);
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  async function subscribe() {
    setState((current) => ({ ...current, busy: true, message: null }));
    try {
      if (!publicKey) {
        setState((current) => ({
          ...current,
          busy: false,
          message: 'Push is not configured on the server (missing VAPID_PUBLIC_KEY).',
        }));
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState((current) => ({
          ...current,
          permission,
          busy: false,
          message: 'Notifications stay off. You can turn them on later in the browser settings.',
        }));
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // VAPID identifies this app to the push service; the key is public and safe in the bundle.
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const response = await fetch('/api/v1/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) {
        throw new Error(`Server refused the subscription (${response.status})`);
      }
      setState((current) => ({
        ...current,
        permission: 'granted',
        subscribed: true,
        busy: false,
        message: 'Notifications on: a draft ready, a failed publish, or an expiring approval.',
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        busy: false,
        message: error instanceof Error ? error.message : 'Could not enable notifications.',
      }));
    }
  }

  async function unsubscribe() {
    setState((current) => ({ ...current, busy: true, message: null }));
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch('/api/v1/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setState((current) => ({
        ...current,
        subscribed: false,
        busy: false,
        message: 'Notifications off.',
      }));
    } catch {
      setState((current) => ({ ...current, busy: false, message: 'Could not turn notifications off.' }));
    }
  }

  if (!state.supported) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[13px] font-medium">Notifications</p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        Install PostPilot to your home screen and get a push when a draft is ready, a publish fails, or an
        approval is about to expire.
      </p>
      {state.message ? (
        <p className="mt-2 text-[12px] text-muted-foreground">{state.message}</p>
      ) : null}
      <button
        type="button"
        disabled={state.busy}
        onClick={() => (state.subscribed ? void unsubscribe() : void subscribe())}
        className="mt-2 h-11 rounded-lg border border-border bg-background px-3 text-[13px] font-medium disabled:opacity-60"
      >
        {state.busy ? 'Working…' : state.subscribed ? 'Turn off notifications' : 'Enable notifications'}
      </button>
    </div>
  );
}

/** The browser wants a Uint8Array for the VAPID key; base64url has to be converted by hand. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
