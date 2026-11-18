'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  IconCopy,
  IconPublish,
  IconWhatsapp,
} from '@/ui';
import { StatusBadge } from '../status-badge';
import { useToast } from '../toast';

interface WhatsAppStatusDto {
  connected: boolean;
  mode: 'cloud' | 'disabled';
  number: string | null;
  reason: string | null;
  webhookUrl: string;
  verifyTokenSet: boolean;
  appSecretSet: boolean;
}

const SETUP_STEPS = [
  'Create a Meta business portfolio and a Business-type app, then add the WhatsApp product.',
  'Add your own business number (the free test number works while you set things up).',
  'Create a permanent System user token with whatsapp_business_messaging + whatsapp_business_management.',
  'Set the five WHATSAPP_* secrets on the Worker and subscribe the webhook to the "messages" field.',
];

export function WhatsAppPanel() {
  const { data, loading, reload } = useApi<WhatsAppStatusDto>('/whatsapp/status');
  const { busy, run } = useAction();
  const { toast } = useToast();

  const sendTest = () =>
    run(
      () => api.post<{ ok: boolean; message: string }>('/whatsapp/test'),
      (result) => {
        toast(result.message, result.ok ? 'success' : 'error');
        reload();
      },
      (message) => toast(message, 'error'),
    );

  const copyWebhook = () =>
    run(
      () => navigator.clipboard.writeText(data?.webhookUrl ?? ''),
      () => toast('Webhook URL copied.', 'success'),
      () => toast('Could not copy - select the URL manually.', 'error'),
    );

  if (loading && !data) return <Skeleton className="h-40 w-full rounded-xl" />;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>WhatsApp approvals</CardTitle>
        <StatusBadge status={data?.connected ? 'connected' : 'disconnected'} />
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.connected ? (
          <>
            <p className="text-[12px] text-muted-foreground">
              Approval emails now include a one-tap WhatsApp link. Sending the pre-filled code from{' '}
              {data.number} makes the bot reply with the post and Approve / Reject buttons. Replies
              inside the 24-hour window are free (1 000 service messages per number per month).
            </p>
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Webhook URL
              </p>
              <code className="block break-all rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-foreground">
                {data.webhookUrl}
              </code>
            </div>
            {!data.appSecretSet || !data.verifyTokenSet ? (
              <Alert tone="warning" title="Webhook secrets missing">
                Set WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET, otherwise Meta cannot verify the
                webhook and unsigned calls are rejected.
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={busy} onClick={sendTest}>
                <IconPublish className="h-4 w-4" aria-hidden /> IconPublish test message
              </Button>
              <Button size="sm" variant="outline" onClick={copyWebhook}>
                <IconCopy className="h-4 w-4" aria-hidden /> IconCopy webhook URL
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[12px] text-muted-foreground">{data?.reason}</p>
            <ol className="space-y-1.5 text-[12px] text-muted-foreground">
              {SETUP_STEPS.map((step, index) => (
                <li key={step} className="flex gap-2">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="text-[11px] text-muted-foreground">
              Free by design: no templates are sent, so every reply stays inside the free service
              window. Approvals keep working by email in the meantime.
            </p>
          </>
        )}
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <IconWhatsapp className="h-3.5 w-3.5" aria-hidden />
          Official WhatsApp Cloud API only - no unofficial bridges.
        </p>
      </CardContent>
    </Card>
  );
}
