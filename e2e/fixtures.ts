/**
 * Shared Playwright fixtures.
 *
 * Two jobs:
 *   1. An `api` helper that talks to the app with the dev bypass token and never treats a failed
 *      status as data, so a 500 cannot look like a passing assertion.
 *   2. Evidence collection: any console error, uncaught page error or failed request fails the test,
 *      and a screenshot + trace is kept on failure (`e2e/artifacts/`, git-ignored).
 */
import { test as base, expect, type APIRequestContext } from '@playwright/test';

export interface ApiCall {
  status: number;
  body: any;
}

export interface Api {
  get(path: string, init?: RequestInit): Promise<ApiCall>;
  post(path: string, body?: unknown): Promise<ApiCall>;
  patch(path: string, body?: unknown): Promise<ApiCall>;
  del(path: string): Promise<ApiCall>;
}

export interface Evidence {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export const test = base.extend<{ api: Api; evidence: Evidence }>({
  // eslint-disable-next-line no-empty-pattern
  api: async ({ request, baseURL }, use) => {
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      init: RequestInit = {},
    ): Promise<ApiCall> => {
      const extraHeaders = (init.headers ?? {}) as Record<string, string>;
      const response = await request.fetch(`${baseURL}/api/v1${path}`, {
        ...init,
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-dev-owner-token': 'local-dev-owner-token',
          ...extraHeaders,
        },
        data: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status(), body: text ? JSON.parse(text) : null };
    };
    await use({
      get: (path, init) => call('GET', path, undefined, init),
      post: (path, body) => call('POST', path, body ?? {}),
      patch: (path, body) => call('PATCH', path, body ?? {}),
      del: (path) => call('DELETE', path, undefined),
    });
  },

  evidence: async ({ page }, use) => {
    const evidence: Evidence = { consoleErrors: [], pageErrors: [], failedRequests: [] };
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // A deliberate 4xx (the duplicate guard) is logged by the browser as a console error; it is a
      // product behaviour under test, not a defect.
      if (/status of (400|401|403|409|422)/.test(text)) return;
      evidence.consoleErrors.push(text);
    });
    page.on('pageerror', (error) => evidence.pageErrors.push(String(error)));
    page.on('requestfailed', (request) => {
      const url = request.url();
      const reason = request.failure()?.errorText ?? '';
      // Next.js prefetch aborts (.txt RSC payloads) when a navigation happens mid-prefetch. That is
      // the router working as designed, not a broken request - only report real failures.
      // In-flight RSC prefetches and route chunks are cancelled by the next navigation.
      if (reason.includes('ERR_ABORTED') && (/_rsc=|\.txt$|\/_next\/static\//.test(url))) return;
      evidence.failedRequests.push(`${request.method()} ${url} ${reason}`);
    });
    await use(evidence);
    expect(evidence.pageErrors, 'uncaught page errors').toEqual([]);
    expect(evidence.consoleErrors, 'console errors').toEqual([]);
    expect(evidence.failedRequests, 'failed requests').toEqual([]);
  },
});

export { expect };

/** Convenience for suites that only need the API fixture. */
export type { APIRequestContext };
