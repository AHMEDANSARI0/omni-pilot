import { z } from 'zod';
import { AppError } from '@/src/core/errors';

export type EnvSource = Record<string, string | undefined>;

export type AppEnv = 'production' | 'development' | 'test';

export interface AppConfig {
  appEnv: AppEnv;
  /** Public base URL used in approval links and OAuth redirects, no trailing slash. */
  baseUrl: string;
  ownerEmail: string;
  supabase: {
    url: string;
    serviceRoleKey: string;
    anonKey: string;
  };
  auth: {
    approvalTokenSecret: string;
    devOwnerToken: string | null;
    allowDevBypass: boolean;
  };
  crypto: {
    /** 32-byte AES-GCM key for encrypting OAuth tokens at rest. */
    tokenEncryptionKey: Uint8Array;
  };
  ai: {
    provider: string;
    geminiApiKey: string | null;
    defaultModel: string;
  };
  google: {
    clientId: string | null;
    clientSecret: string | null;
    sheetId: string | null;
    sheetTab: string;
    bootstrapRefreshToken: string | null;
  };
  resend: {
    apiKey: string | null;
    fromEmail: string;
  };
  linkedin: {
    clientId: string | null;
    clientSecret: string | null;
    apiVersion: string;
  };
  whatsapp: {
    /** True when a phone number id + token + owner number are present. */
    enabled: boolean;
    phoneNumberId: string | null;
    accessToken: string | null;
    verifyToken: string | null;
    appSecret: string | null;
    /** Owner's personal number (digits only) - the only sender we accept. */
    ownerNumber: string | null;
    apiVersion: string;
  };
  cronSecret: string;
  /** live = real external services, local = deterministic in-process stubs for dev/tests. */
  servicesMode: 'live' | 'local';
  rateLimit: { windowSeconds: number; maxRequests: number };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function readBase64Key(value: string, name: string): Uint8Array {
  const normalized = value.trim();
  let bytes: Uint8Array;
  try {
    const binary = atob(normalized);
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new AppError(
      'CONFIG_ERROR',
      `${name} must be base64 encoded. Generate it with: openssl rand -base64 32`,
    );
  }
  if (bytes.length !== 32) {
    throw new AppError(
      'CONFIG_ERROR',
      `${name} must decode to exactly 32 bytes (got ${bytes.length}).`,
    );
  }
  return bytes;
}

const booleanish = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : null));

/**
 * Central configuration loader. Throws CONFIG_ERROR listing the missing variable names
 * (never their values) so a broken deployment fails fast instead of silently misbehaving.
 */
export function loadConfig(source: EnvSource): AppConfig {
  const appEnvRaw = (source.APP_ENV || source.NODE_ENV || 'development').toLowerCase();
  const appEnv: AppEnv =
    appEnvRaw === 'production' ? 'production' : appEnvRaw === 'test' ? 'test' : 'development';

  const servicesMode: 'live' | 'local' =
    (source.SERVICES_MODE || (appEnv === 'production' ? 'live' : 'local')) === 'live'
      ? 'live'
      : 'local';

  const parsed = z
    .object({
      APP_BASE_URL: z.string().url().optional(),
      OWNER_EMAIL: z.string().email().optional(),
      SUPABASE_URL: z.string().url().optional(),
      SUPABASE_SERVICE_ROLE_KEY: optionalString,
      SUPABASE_ANON_KEY: optionalString,
      APPROVAL_TOKEN_SECRET: optionalString,
      TOKEN_ENCRYPTION_KEY: optionalString,
      DEV_OWNER_TOKEN: optionalString,
      ALLOW_DEV_BYPASS: booleanish,
      GEMINI_API_KEY: optionalString,
      AI_PROVIDER: z.string().optional(),
      GEMINI_MODEL: z.string().optional(),
      GOOGLE_CLIENT_ID: optionalString,
      GOOGLE_CLIENT_SECRET: optionalString,
      GOOGLE_SHEET_ID: optionalString,
      GOOGLE_SHEET_TAB: z.string().optional(),
      GOOGLE_REFRESH_TOKEN: optionalString,
      RESEND_API_KEY: optionalString,
      RESEND_FROM_EMAIL: optionalString,
      LINKEDIN_CLIENT_ID: optionalString,
      LINKEDIN_CLIENT_SECRET: optionalString,
      LINKEDIN_API_VERSION: z.string().optional(),
      WHATSAPP_PHONE_NUMBER_ID: optionalString,
      WHATSAPP_ACCESS_TOKEN: optionalString,
      WHATSAPP_VERIFY_TOKEN: optionalString,
      WHATSAPP_APP_SECRET: optionalString,
      WHATSAPP_OWNER_NUMBER: optionalString,
      WHATSAPP_API_VERSION: z.string().optional(),
      CRON_SECRET: optionalString,
      RATE_LIMIT_WINDOW_SECONDS: z.string().optional(),
      RATE_LIMIT_MAX_REQUESTS: z.string().optional(),
    })
    .parse(source);

  const missing: string[] = [];
  if (!parsed.APP_BASE_URL) missing.push('APP_BASE_URL');
  if (!parsed.OWNER_EMAIL) missing.push('OWNER_EMAIL');
  if (!parsed.APPROVAL_TOKEN_SECRET || parsed.APPROVAL_TOKEN_SECRET.length < 32) {
    missing.push('APPROVAL_TOKEN_SECRET (min 32 chars)');
  }
  if (!parsed.TOKEN_ENCRYPTION_KEY) missing.push('TOKEN_ENCRYPTION_KEY');
  if (servicesMode === 'live') {
    if (!parsed.SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!parsed.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!parsed.SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
    if (!parsed.CRON_SECRET || parsed.CRON_SECRET.length < 24) {
      missing.push('CRON_SECRET (min 24 chars)');
    }
  }
  if (missing.length > 0) {
    throw new AppError(
      'CONFIG_ERROR',
      `Missing or invalid environment variables: ${missing.join(', ')}`,
    );
  }

  const allowDevBypass = parsed.ALLOW_DEV_BYPASS;
  if (appEnv === 'production' && allowDevBypass) {
    throw new AppError(
      'CONFIG_ERROR',
      'ALLOW_DEV_BYPASS must not be enabled when APP_ENV=production.',
    );
  }

  const baseUrl = parsed.APP_BASE_URL!.replace(/\/+$/, '');

  return {
    appEnv,
    baseUrl,
    ownerEmail: parsed.OWNER_EMAIL!,
    supabase: {
      url: (parsed.SUPABASE_URL ?? 'http://localhost:54321').replace(/\/+$/, ''),
      serviceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY ?? 'local-service-role-key',
      anonKey: parsed.SUPABASE_ANON_KEY ?? '',
    },
    auth: {
      approvalTokenSecret: parsed.APPROVAL_TOKEN_SECRET!,
      devOwnerToken: parsed.DEV_OWNER_TOKEN,
      allowDevBypass,
    },
    crypto: {
      tokenEncryptionKey: readBase64Key(parsed.TOKEN_ENCRYPTION_KEY!, 'TOKEN_ENCRYPTION_KEY'),
    },
    ai: {
      provider: parsed.AI_PROVIDER || 'gemini',
      geminiApiKey: parsed.GEMINI_API_KEY,
      defaultModel: parsed.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    google: {
      clientId: parsed.GOOGLE_CLIENT_ID,
      clientSecret: parsed.GOOGLE_CLIENT_SECRET,
      sheetId: parsed.GOOGLE_SHEET_ID,
      sheetTab: parsed.GOOGLE_SHEET_TAB || 'Content',
      bootstrapRefreshToken: parsed.GOOGLE_REFRESH_TOKEN,
    },
    resend: {
      apiKey: parsed.RESEND_API_KEY,
      fromEmail: parsed.RESEND_FROM_EMAIL || 'LinkedIn Automation <onboarding@resend.dev>',
    },
    linkedin: {
      clientId: parsed.LINKEDIN_CLIENT_ID,
      clientSecret: parsed.LINKEDIN_CLIENT_SECRET,
      apiVersion: parsed.LINKEDIN_API_VERSION || '202506',
    },
    whatsapp: {
      enabled: Boolean(
        parsed.WHATSAPP_PHONE_NUMBER_ID &&
        parsed.WHATSAPP_ACCESS_TOKEN &&
        parsed.WHATSAPP_OWNER_NUMBER,
      ),
      phoneNumberId: parsed.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: parsed.WHATSAPP_ACCESS_TOKEN,
      verifyToken: parsed.WHATSAPP_VERIFY_TOKEN,
      appSecret: parsed.WHATSAPP_APP_SECRET,
      ownerNumber: parsed.WHATSAPP_OWNER_NUMBER
        ? parsed.WHATSAPP_OWNER_NUMBER.replace(/[^0-9]/g, '')
        : null,
      apiVersion: parsed.WHATSAPP_API_VERSION || 'v21.0',
    },
    cronSecret: parsed.CRON_SECRET ?? 'local-cron-secret',
    servicesMode,
    rateLimit: {
      windowSeconds: Number(parsed.RATE_LIMIT_WINDOW_SECONDS ?? 60),
      maxRequests: Number(parsed.RATE_LIMIT_MAX_REQUESTS ?? 120),
    },
  };
}

export { HHMM };
