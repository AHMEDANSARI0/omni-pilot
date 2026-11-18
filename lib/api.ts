'use client';

import {
  clearSession,
  getSession,
  isExpiringSoon,
  saveSession,
  type AuthMode,
  type Session,
} from './session';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

let refreshInFlight: Promise<Session | null> | null = null;

export function apiUrl(path: string): string {
  return `/api/v1${path}`;
}

async function refreshSession(): Promise<Session | null> {
  const session = getSession();
  if (!session) return null;
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(apiUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      const payload = (await response.json()) as ApiEnvelope<Session>;
      if (!response.ok || !payload.ok || !payload.data) {
        clearSession();
        return null;
      }
      saveSession(payload.data);
      return payload.data;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function authHeaders(): Promise<Record<string, string>> {
  let session = getSession();
  if (session && isExpiringSoon(session)) {
    session = (await refreshSession()) ?? getSession();
  }
  return session ? { Authorization: `Bearer ${session.accessToken}` } : {};
}

/**
 * Single entry point for dashboard API calls: envelopes, auth, one refresh-and-retry.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, ...rest } = init;

  const run = async (): Promise<Response> =>
    fetch(apiUrl(path), {
      ...rest,
      headers: {
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? await authHeaders() : {}),
        ...(rest.headers as Record<string, string>),
      },
    });

  let response = await run();
  if (response.status === 401 && auth) {
    const refreshed = await refreshSession();
    if (refreshed) response = await run();
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;

  if (!response.ok || !payload || payload.ok === false) {
    const error = payload?.error;
    throw new ApiRequestError(
      error?.message ?? `Request failed (${response.status})`,
      error?.code ?? 'REQUEST_FAILED',
      response.status,
      error?.details,
    );
  }
  return payload.data as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
  public: <T>(path: string) => apiFetch<T>(path, { auth: false }),
  publicPost: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body), auth: false }),
};

export async function fetchAuthMode(): Promise<AuthMode> {
  return apiFetch<AuthMode>('/auth/mode', { auth: false });
}

export async function signIn(email: string, password: string): Promise<Session> {
  const session = await apiFetch<Session>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    auth: false,
  });
  saveSession(session);
  return session;
}

export function signOut(): void {
  clearSession();
}
