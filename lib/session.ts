'use client';

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  email: string;
}

export interface AuthMode {
  requiresAuth: boolean;
  devBypass: boolean;
  supabaseConfigured: boolean;
  servicesMode: string;
  ownerEmailHint: string;
}

const STORAGE_KEY = 'lsa.session.v1';

export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function isExpiringSoon(session: Session, withinSeconds = 60): boolean {
  return new Date(session.expiresAt).getTime() - Date.now() < withinSeconds * 1000;
}
