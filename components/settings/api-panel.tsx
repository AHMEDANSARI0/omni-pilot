'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Skeleton } from '@/ui';
import { useToast } from '../toast';

/**
 * Settings → API: the OmniFlow keys and outbound webhooks.
 *
 * Two rules shape this screen:
 *   1. A secret is shown exactly once and never again - the key on creation, the webhook secret on
 *      creation or rotation. Everything else shows a prefix, because a prefix is enough to tell two
 *      keys apart and useless to anyone who finds it.
 *   2. Nothing here can be created by accident: a key needs a name, a webhook needs a URL, and both
 *      start inactive in the sense that they do nothing until a scope or an event is chosen.
 */
interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  failureCount: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  secretPrefix: string;
}

interface DeliveryRow {
  id: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  nextAttemptAt: string;
  createdAt: string;
}

interface AdminDto {
  keys: ApiKeyRow[];
  endpoints: WebhookRow[];
  events: string[];
  recentDeliveries: DeliveryRow[];
}

const SCOPES = ['read', 'write', 'publish'] as const;

export function ApiPanel() {
  const keys = useApi<{ keys: ApiKeyRow[] }>('/omni/admin/keys');
  const hooks = useApi<{ endpoints: WebhookRow[]; events: string[]; recentDeliveries: DeliveryRow[] }>(
    '/omni/admin/webhooks',
  );
  const { toast } = useToast();

  const [keyName, setKeyName] = React.useState('');
  const [scopes, setScopes] = React.useState<string[]>(['read']);
  const [newKey, setNewKey] = React.useState<string | null>(null);
  const [hookName, setHookName] = React.useState('');
  const [hookUrl, setHookUrl] = React.useState('');
  const [hookEvents, setHookEvents] = React.useState<string[]>(['post.published']);
  const [newSecret, setNewSecret] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const createKey = async () => {
    setBusy(true);
    try {
      const response = await api.post<{ key: string }>('/omni/admin/keys', {
        name: keyName || 'Untitled key',
        scopes,
      });
      setNewKey(response.key);
      setKeyName('');
      keys.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not create the key.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const revokeKey = async (id: string) => {
    try {
      await api.delete(`/omni/admin/keys/${id}`);
      toast('Key revoked. It stops working immediately.', 'success');
      keys.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not revoke the key.', 'error');
    }
  };

  const createHook = async () => {
    setBusy(true);
    try {
      const response = await api.post<{ secret: string }>('/omni/admin/webhooks', {
        name: hookName || 'Untitled webhook',
        url: hookUrl,
        events: hookEvents,
      });
      setNewSecret(response.secret);
      setHookName('');
      setHookUrl('');
      hooks.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not add the webhook.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (id: string) => {
    try {
      const response = await api.patch<{ secret: string }>(`/omni/admin/webhooks/${id}`, {
        rotateSecret: true,
      });
      setNewSecret(response.secret);
      hooks.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not rotate the secret.', 'error');
    }
  };

  const removeHook = async (id: string) => {
    try {
      await api.delete(`/omni/admin/webhooks/${id}`);
      toast('Webhook removed.', 'success');
      hooks.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not remove the webhook.', 'error');
    }
  };

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[12.5px] text-muted-foreground">
            For other tools: send <code className="rounded bg-muted px-1">Authorization: Bearer opk_…</code>{' '}
            to <code className="rounded bg-muted px-1">/api/v1/omni</code>. A key is hashed on the server,
            so it is shown once and cannot be recovered.
          </p>

          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Field label="Key name" htmlFor="key-name" hint="Where will this key live?">
              <Input
                id="key-name"
                value={keyName}
                placeholder="OmniFlow"
                onChange={(event) => setKeyName(event.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <Button className="h-11 w-full sm:h-9" disabled={busy} onClick={() => void createKey()}>
                Create key
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {SCOPES.map((scope) => (
              <button
                key={scope}
                type="button"
                aria-pressed={scopes.includes(scope)}
                onClick={() => setScopes(toggle(scopes, scope))}
                className={`h-11 rounded-full border px-3 text-[12.5px] font-medium sm:h-8 ${
                  scopes.includes(scope)
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground'
                }`}
              >
                {scope}
              </button>
            ))}
          </div>

          {newKey ? (
            <Alert tone="warning" title="Copy this key now">
              <code className="mt-1 block break-all rounded bg-background p-2 text-[12px]">{newKey}</code>
              <span className="mt-1 block">It is not stored in readable form and cannot be shown again.</span>
            </Alert>
          ) : null}

          {keys.loading ? <Skeleton className="h-16 w-full" /> : null}
          {keys.data?.keys.length ? (
            <ul className="divide-y divide-border">
              {keys.data.keys.map((key) => (
                <li key={key.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{key.name}</p>
                    <p className="truncate font-mono text-[12px] text-muted-foreground">
                      {key.keyPrefix}… · {key.scopes.join(', ') || 'no scopes'}
                      {key.revokedAt ? ' · revoked' : ''}
                    </p>
                  </div>
                  {key.revokedAt ? null : (
                    <Button
                      variant="ghost"
                      className="h-11 shrink-0 sm:h-9"
                      onClick={() => void revokeKey(key.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[12.5px] text-muted-foreground">
            An event is delivered once, signed as{' '}
            <code className="rounded bg-muted px-1">sha256=HMAC(secret, &quot;&lt;timestamp&gt;.&lt;body&gt;&quot;)</code>.
            Server errors are retried with backoff; a 4xx (other than 429) is treated as permanent.
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Name" htmlFor="hook-name">
              <Input
                id="hook-name"
                value={hookName}
                placeholder="OmniFlow"
                onChange={(event) => setHookName(event.target.value)}
              />
            </Field>
            <Field label="URL" htmlFor="hook-url" hint="https://">
              <Input
                id="hook-url"
                value={hookUrl}
                placeholder="https://omniflow.example/api/hooks"
                onChange={(event) => setHookUrl(event.target.value)}
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(hooks.data?.events ?? ['post.published']).map((event) => (
              <button
                key={event}
                type="button"
                aria-pressed={hookEvents.includes(event)}
                onClick={() => setHookEvents(toggle(hookEvents, event))}
                className={`h-11 rounded-full border px-3 text-[12px] font-medium sm:h-8 ${
                  hookEvents.includes(event)
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground'
                }`}
              >
                {event}
              </button>
            ))}
          </div>

          <Button
            className="h-11 w-full sm:h-9 sm:w-auto"
            disabled={busy || hookUrl.length < 8}
            onClick={() => void createHook()}
          >
            Add webhook
          </Button>

          {newSecret ? (
            <Alert tone="warning" title="Signing secret">
              <code className="mt-1 block break-all rounded bg-background p-2 text-[12px]">{newSecret}</code>
              <span className="mt-1 block">Shown once. Rotate if it leaks.</span>
            </Alert>
          ) : null}

          {hooks.loading ? <Skeleton className="h-16 w-full" /> : null}
          {hooks.data?.endpoints.length ? (
            <ul className="divide-y divide-border">
              {hooks.data.endpoints.map((hook) => (
                <li key={hook.id} className="space-y-1 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">{hook.name}</p>
                      <p className="truncate text-[12px] text-muted-foreground">{hook.url}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {hook.events.join(', ')} · {hook.active ? 'active' : 'disabled'}
                        {hook.failureCount > 0 ? ` · ${hook.failureCount} consecutive failures` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" className="h-11 sm:h-9" onClick={() => void rotate(hook.id)}>
                        Rotate
                      </Button>
                      <Button variant="ghost" className="h-11 sm:h-9" onClick={() => void removeHook(hook.id)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                  {hook.lastError ? (
                    <p className="text-[12px] text-destructive">Last error: {hook.lastError}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {hooks.data?.recentDeliveries.length ? (
            <details className="rounded-xl border border-border bg-muted/30 p-2">
              <summary className="cursor-pointer text-[12.5px] font-medium">Recent deliveries</summary>
              <ul className="mt-1 space-y-1">
                {hooks.data.recentDeliveries.map((delivery) => (
                  <li key={delivery.id} className="font-mono text-[11.5px] text-muted-foreground">
                    {delivery.event} · {delivery.status} · attempt {delivery.attempts}
                    {delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
