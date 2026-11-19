'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import type { SettingsDto } from '@/lib/types';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  IconSignOut,
} from '@/ui';
import { SchedulePanel } from '@/components/settings/schedule-panel';
import { AiPanel } from '@/components/settings/ai-panel';
import { IntegrationsPanel } from '@/components/settings/integrations-panel';
import { LogsPanel } from '@/components/settings/logs-panel';
import { ApiPanel } from '@/components/settings/api-panel';
import { PwaBridge } from '@/components/pwa-bridge';
import { useAuthMode } from '@/components/auth-guard';
import { useToast } from '@/components/toast';

type Tab = 'schedule' | 'ai' | 'integrations' | 'api' | 'logs' | 'account';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'schedule', label: 'Schedule' },
  { id: 'ai', label: 'AI voice' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'api', label: 'API' },
  { id: 'logs', label: 'Logs' },
  { id: 'account', label: 'Account' },
];

export default function SettingsPage() {
  const [tab, setTab] = React.useState<Tab>('schedule');
  const { data, error, loading, reload } = useApi<{
    settings: SettingsDto;
    ai: { provider: string; model: string };
    servicesMode: string;
    ownerEmail: string;
    baseUrl: string;
  }>('/settings');
  const mode = useAuthMode();
  const { toast } = useToast();
  const router = useRouter();

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('tab') as Tab | null;
    if (requested && TABS.some((item) => item.id === requested)) setTab(requested);
    const connected = params.get('connected');
    const oauthError = params.get('error');
    if (connected) toast(`${connected.replace('_', ' ')} connected.`, 'success');
    if (oauthError) toast(`Authorization failed: ${oauthError}`, 'error');
    if (connected || oauthError) {
      window.history.replaceState({}, '', `/settings/?tab=integrations`);
    }
  }, [toast]);

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Alert tone="error" title="Could not load settings">
        {error}
      </Alert>
    );
  }

  const timeZone = data.settings.ownerTimezone;

  return (
    <div className="space-y-3">
      <div className="-mx-4 overflow-x-auto px-4 no-scrollbar">
        <div className="flex w-max gap-1.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={tab === item.id ? 'true' : undefined}
              onClick={() => setTab(item.id)}
              className={`h-11 min-h-11 whitespace-nowrap rounded-lg border px-3 text-[12.5px] font-medium transition-colors md:h-8 md:min-h-0 ${
                tab === item.id
                  ? 'border-transparent bg-primary text-primary-foreground shadow-sm'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'schedule' ? <SchedulePanel settings={data.settings} onSaved={reload} /> : null}
      {tab === 'ai' ? <AiPanel settings={data.settings} onSaved={reload} /> : null}
      {tab === 'integrations' ? <IntegrationsPanel timeZone={timeZone} /> : null}
      {tab === 'api' ? <ApiPanel /> : null}
      {tab === 'logs' ? <LogsPanel timeZone={timeZone} /> : null}
      {tab === 'account' ? (
        <div className="space-y-3">
          {/* Phase 10: registering the service worker is what makes the app installable, so it
              happens on a page the owner actually visits rather than invisibly at startup. */}
          <PwaBridge />
          <Card>
            <CardHeader>
              <CardTitle>Account</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-[13px]">
              <p>
                Owner email: <span className="font-medium">{data.ownerEmail}</span>
              </p>
              <p className="text-muted-foreground">Base URL: {data.baseUrl}</p>
              <p className="text-muted-foreground">
                Mode: {data.servicesMode} · AI: {data.ai.provider} / {data.ai.model}
              </p>
              {mode?.devBypass ? (
                <Alert tone="warning" title="Local dev bypass active">
                  The dashboard API is unauthenticated. It is impossible to enable this in
                  production.
                </Alert>
              ) : null}
            </CardContent>
          </Card>
          {!mode?.devBypass && mode?.requiresAuth ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                signOut();
                router.replace('/signin/');
              }}
            >
              <IconSignOut className="h-4 w-4" aria-hidden /> Sign out
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
