'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { fetchAuthMode, signIn } from '@/lib/api';
import type { AuthMode } from '@/lib/session';
import {
  Alert,
  Button,
  Field,
  Input,
  IconAi,
  IconBrand,
  IconNext,
  IconQueue,
  IconSecurity,
} from '@/ui';

const HIGHLIGHTS = [
  { icon: IconAi, title: 'AI drafts', detail: 'Gemini writes in your voice' },
  { icon: IconQueue, title: 'Cloud schedule', detail: 'Publishes with no laptop on' },
  { icon: IconSecurity, title: 'Email approval', detail: 'Nothing posts without your tap' },
];

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = React.useState<AuthMode | null>(null);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    fetchAuthMode()
      .then((result) => {
        setMode(result);
        if (!result.requiresAuth) router.replace('/');
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Cannot reach the API'),
      );
  }, [router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace('/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col gap-3 p-3 lg:flex-row lg:gap-4">
      <aside className="mesh-orb relative hidden flex-1 flex-col justify-between overflow-hidden rounded-[32px] border border-white/70 p-10 text-ink lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/40 blur-2xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-warm/50 blur-3xl"
        />

        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/70 bg-white/55 backdrop-blur">
            <IconBrand className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">PostPilot</span>
        </div>

        <div className="relative max-w-md">
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">
            Your LinkedIn pipeline, on autopilot.
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-ink/70">
            Plan in Google Sheets, let Gemini write, approve from your phone, publish through the
            official LinkedIn API.
          </p>

          <ul className="mt-8 space-y-3">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/60 bg-white/50 backdrop-blur">
                  <item.icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{item.title}</span>
                  <span className="block text-[12px] text-white/70">{item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[11.5px] text-ink/55">
          Free-tier infrastructure · personal use only
        </p>
      </aside>

      <main className="flex flex-1 flex-col justify-center px-1 py-8 sm:px-4 sm:py-10">
        <div className="glass mx-auto w-full max-w-sm rounded-[28px] p-5 sm:p-6">
          <div className="mb-7 flex items-center gap-2.5 lg:hidden">
            <span className="mesh-orb flex h-9 w-9 items-center justify-center rounded-xl border border-white/70">
              <IconBrand className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">PostPilot</span>
          </div>

          <h2 className="text-[22px] font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Owner account only. Create the user in Supabase Auth first.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-3.5">
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={mode?.ownerEmailHint ?? 'you@example.com'}
                className="h-11"
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-11"
              />
            </Field>

            {error ? <Alert tone="error">{error}</Alert> : null}
            {mode && !mode.supabaseConfigured ? (
              <Alert tone="warning" title="Supabase Auth not configured">
                Set SUPABASE_ANON_KEY on the server, then create the owner user in the Supabase
                dashboard.
              </Alert>
            ) : null}

            <Button type="submit" className="h-11 w-full" loading={busy}>
              Sign in
              <IconNext className="h-4 w-4" aria-hidden />
            </Button>
          </form>

          <p className="mt-6 text-[11.5px] leading-relaxed text-muted-foreground">
            Local development runs without a login (
            <code className="rounded bg-muted px-1">ALLOW_DEV_BYPASS=true</code>). This switch is
            rejected when <code className="rounded bg-muted px-1">APP_ENV=production</code>.
          </p>
        </div>
      </main>
    </div>
  );
}
