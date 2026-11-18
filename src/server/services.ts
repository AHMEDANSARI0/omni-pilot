import { loadConfig, type AppConfig, type EnvSource } from '@/src/config/env';
import { AppError } from '@/src/core/errors';
import { createLogger } from '@/src/core/logger';
import { systemClock, type Services } from '@/src/core/services';
import type {
  AiProvider,
  Cipher,
  Clock,
  Database,
  EmailGateway,
  LinkedInGateway,
  SheetsGateway,
  WhatsAppGateway,
} from '@/src/core/ports';
import { GeminiProvider } from '@/src/adapters/ai/gemini';
import { LocalAiProvider } from '@/src/adapters/ai/local';
import { PostgrestDatabase } from '@/src/adapters/db/postgrest';
import { MemoryDatabase } from '@/src/adapters/db/memory';
import { GoogleSheetsGateway } from '@/src/adapters/sheets/google-sheets';
import { ResendEmailGateway } from '@/src/adapters/services/resend';
import {
  LocalEmailGateway,
  LocalLinkedInGateway,
  LocalSheetsGateway,
} from '@/src/adapters/services/local';
import { LinkedInGatewayImpl } from '@/src/adapters/linkedin/linkedin';
import { CloudWhatsAppGateway } from '@/src/adapters/services/whatsapp-cloud';
import { DisabledWhatsAppGateway } from '@/src/adapters/services/whatsapp';
import { createCipher } from '@/src/adapters/storage/cipher';

export interface ServiceOverrides {
  db?: Database;
  ai?: AiProvider;
  sheets?: SheetsGateway;
  email?: EmailGateway;
  linkedin?: LinkedInGateway;
  whatsapp?: WhatsAppGateway;
  cipher?: Cipher;
  clock?: Clock;
  config?: AppConfig;
}

interface LocalStore {
  db: MemoryDatabase;
  sheets: LocalSheetsGateway;
  email: LocalEmailGateway;
  linkedin: LocalLinkedInGateway;
}

const globalForDev = globalThis as typeof globalThis & { __linkedinAutomationLocal?: LocalStore };

function localStore(clock: Clock): LocalStore {
  globalForDev.__linkedinAutomationLocal ??= {
    db: new MemoryDatabase(clock),
    sheets: new LocalSheetsGateway(),
    email: new LocalEmailGateway(),
    linkedin: new LocalLinkedInGateway(),
  };
  return globalForDev.__linkedinAutomationLocal;
}

/**
 * Composition root: builds every adapter from configuration once per request.
 * Business logic only ever sees the ports, never the concrete adapters.
 */
export async function createServices(
  env: EnvSource,
  overrides: ServiceOverrides = {},
): Promise<Services> {
  const config = overrides.config ?? loadConfig(env);
  const clock = overrides.clock ?? systemClock();

  if (config.appEnv === 'production' && config.servicesMode === 'local') {
    throw new AppError(
      'CONFIG_ERROR',
      'Refusing to start: local service stubs are not allowed with APP_ENV=production. Set SERVICES_MODE=live.',
    );
  }

  let db: Database;
  let ai: AiProvider;
  let sheets: SheetsGateway;
  let email: EmailGateway;
  let linkedin: LinkedInGateway;

  const cipher = overrides.cipher ?? createCipher(config.crypto.tokenEncryptionKey);
  const local = config.servicesMode === 'local' ? localStore(clock) : null;

  db =
    overrides.db ??
    local?.db ??
    PostgrestDatabase.create({
      url: config.supabase.url,
      serviceRoleKey: config.supabase.serviceRoleKey,
    });

  const settings = await db.getSettings().catch((error: unknown) => {
    if (overrides.db) return null;
    throw new AppError(
      'DATABASE_ERROR',
      `Cannot read settings: ${error instanceof Error ? error.message : String(error)}. Have the Supabase migrations been applied?`,
      { cause: error },
    );
  });

  if (overrides.ai) {
    ai = overrides.ai;
  } else if (config.servicesMode === 'local') {
    ai = new LocalAiProvider();
  } else {
    const model = settings?.aiModel || config.ai.defaultModel;
    switch (config.ai.provider) {
      case 'gemini': {
        if (!config.ai.geminiApiKey) {
          throw new AppError('CONFIG_ERROR', 'GEMINI_API_KEY is required when AI_PROVIDER=gemini.');
        }
        ai = new GeminiProvider({ apiKey: config.ai.geminiApiKey, model });
        break;
      }
      default:
        throw new AppError(
          'CONFIG_ERROR',
          `Unknown AI_PROVIDER "${config.ai.provider}". Implement the AiProvider port for it and register it in src/server/services.ts.`,
        );
    }
  }

  sheets = overrides.sheets ?? local?.sheets ?? new GoogleSheetsGateway({ db, cipher, config });
  email =
    overrides.email ??
    local?.email ??
    new ResendEmailGateway({ apiKey: config.resend.apiKey, fromEmail: config.resend.fromEmail });
  linkedin =
    overrides.linkedin ?? local?.linkedin ?? new LinkedInGatewayImpl({ db, cipher, config });
  const whatsapp = overrides.whatsapp ?? createWhatsApp(config);

  return {
    config,
    db,
    ai,
    sheets,
    email,
    linkedin,
    whatsapp,
    cipher,
    clock,
    logger: createLogger(db),
  };
}

/** WhatsApp is optional: without credentials the approval channel simply stays off. */
function createWhatsApp(config: AppConfig): WhatsAppGateway {
  const settings = config.whatsapp;
  if (
    !settings.enabled ||
    !settings.phoneNumberId ||
    !settings.accessToken ||
    !settings.ownerNumber
  ) {
    return new DisabledWhatsAppGateway();
  }
  return new CloudWhatsAppGateway({
    phoneNumberId: settings.phoneNumberId,
    accessToken: settings.accessToken,
    appSecret: settings.appSecret,
    ownerNumber: settings.ownerNumber,
    apiVersion: settings.apiVersion,
  });
}

/** Test/dev helper: reset the shared local store between test cases. */
export function resetLocalStore(): void {
  delete globalForDev.__linkedinAutomationLocal;
}
