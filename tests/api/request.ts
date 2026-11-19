/**
 * Shared request helpers for the API suites.
 *
 * Every suite boots the real Hono app against the in-memory database, so these helpers are the only
 * thing the split files share. Kept separate so each suite file stays inside the 250-line rule.
 */
import { createApp } from '@/src/worker/app';
import type { Harness } from '../helpers';

export const BASE = 'http://automation.test';

export function appFor(harness: Harness, services = harness.services) {
  return createApp({ serviceFactory: async () => services });
}

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export async function call(
  app: ReturnType<typeof createApp>,
  harness: Harness,
  path: string,
  init: RequestInit = {},
): Promise<ApiResult> {
  const response = await app.fetch(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string>),
      },
    }),
    harness.env as Record<string, string>,
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
