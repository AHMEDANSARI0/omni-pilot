import type { AppConfig } from '@/src/config/env';
import type {
  AiProvider,
  Cipher,
  Clock,
  Database,
  EmailGateway,
  LinkedInGateway,
  SheetsGateway,
  WhatsAppGateway,
} from './ports';
import type { Logger } from './logger';

export interface Services {
  config: AppConfig;
  db: Database;
  ai: AiProvider;
  sheets: SheetsGateway;
  email: EmailGateway;
  linkedin: LinkedInGateway;
  whatsapp: WhatsAppGateway;
  cipher: Cipher;
  clock: Clock;
  logger: Logger;
}

export function systemClock(): Clock {
  return { now: () => new Date() };
}

export const MAX_GENERATION_ATTEMPTS_PER_DAY = 3;
export const MAX_PUBLISH_ATTEMPTS = 3;
export const PUBLISH_BACKOFF_MINUTES = [2, 5, 15];
