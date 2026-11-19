import { createCipher } from '@/src/adapters/storage/cipher';
import { MemoryDatabase } from '@/src/adapters/db/memory';
import { loadConfig, type AppConfig } from '@/src/config/env';
import { createLogger } from '@/src/core/logger';
import type {
  AiProvider,
  Clock,
  Database,
  EmailGateway,
  EmailMessage,
  GeneratePostInput,
  LinkedInGateway,
  LinkedInStatus,
  SheetRowUpdate,
  SheetSnapshot,
  SheetsGateway,
  WhatsAppGateway,
  WhatsAppInbound,
  WhatsAppStatus,
} from '@/src/core/ports';
import type { Services } from '@/src/core/services';
import { defaultSettings } from '@/src/core/defaults';
import type { DraftContent, DraftVariant, Settings } from '@/src/core/types';
import { AppError } from '@/src/core/errors';
import { hashApprovalToken } from '@/src/core/tokens';

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
  set(iso: string): void {
    this.current = new Date(iso);
  }
}

export const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({
    APP_ENV: 'test',
    APP_BASE_URL: 'https://automation.test',
    OWNER_EMAIL: 'owner@example.com',
    APPROVAL_TOKEN_SECRET: 'test-approval-secret-value-with-enough-length',
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    SERVICES_MODE: 'local',
    CRON_SECRET: 'test-cron-secret-with-enough-length',
    ALLOW_DEV_BYPASS: 'true',
    ...overrides,
  });
}

export class FakeAiProvider implements AiProvider {
  readonly id = 'fake-ai';
  readonly model = 'fake-model-1';
  calls: GeneratePostInput[] = [];
  responses: Array<DraftContent | DraftVariant | Array<DraftContent | DraftVariant> | Error> = [];
  private defaultDraft(input: GeneratePostInput): DraftContent {
    return {
      hook: `A concrete lesson about ${input.topic.toLowerCase()}.`,
      body: [
        'The first version worked in a demo and failed in production because nothing recorded which step had already run.',
        'We added an idempotency key per step, stored the outcome before returning, and made every retry start from the last known state instead of the beginning.',
        'Debugging changed from guesswork to reading a single log line, and duplicate records stopped appearing after timeouts.',
        'If you are building automation around agents, design the failure path before the happy path.',
      ].join('\n\n'),
      hashtags: ['AgenticAI', 'AIAutomation', 'Engineering'],
    };
  }

  /** Set to a function to exercise the Phase 6 planning flow; unset means "not supported". */
  suggestTopics?: (input: { systemInstruction: string; prompt: string }, count: number) => Promise<string>;

  async generatePost(input: GeneratePostInput): Promise<DraftContent> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (Array.isArray(next)) return next[0] ?? this.defaultDraft(input);
    return next ?? this.defaultDraft(input);
  }

  /** Same one-call-many-drafts contract as the real providers. */
  async generateVariants(input: GeneratePostInput, count: number): Promise<DraftVariant[]> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (Array.isArray(next)) {
      return next.map((draft, index) => ({
        ...draft,
        angle: (draft as DraftVariant).angle ?? `Option ${index + 1}`,
      }));
    }
    if (next) return [{ ...next, angle: (next as DraftVariant).angle ?? 'Draft' }];
    const base = this.defaultDraft(input);
    const angles = ['Failure story', 'Short how-to', 'Trade-off'];
    return Array.from({ length: Math.min(Math.max(count, 2), angles.length) }, (_, index) => ({
      ...base,
      hook: index === 0 ? base.hook : `${base.hook} (take ${index + 1})`,
      angle: angles[index] ?? `Option ${index + 1}`,
    }));
  }
}

export class FakeEmailGateway implements EmailGateway {
  sent: Array<EmailMessage & { messageId: string }> = [];
  failNext = 0;
  describe(): Promise<{ connected: boolean; fromEmail: string }> {
    return Promise.resolve({ connected: true, fromEmail: 'automation@test.dev' });
  }
  send(message: EmailMessage): Promise<{ messageId: string }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new AppError('EMAIL_ERROR', 'Simulated email failure'));
    }
    const messageId = `msg-${this.sent.length + 1}`;
    this.sent.push({ ...message, messageId });
    return Promise.resolve({ messageId });
  }
}

export const TEST_WHATSAPP_ENV = {
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_ACCESS_TOKEN: 'test-whatsapp-token',
  WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  WHATSAPP_OWNER_NUMBER: '+92 300 1234567',
  WHATSAPP_API_VERSION: 'v21.0',
};

export class FakeWhatsAppGateway implements WhatsAppGateway {
  readonly id = 'whatsapp-cloud';
  sent: Array<{
    to: string;
    body: string;
    kind: 'text' | 'buttons';
    buttons?: Array<{ id: string; title: string }>;
  }> = [];
  queue: WhatsAppInbound[] = [];
  readIds: string[] = [];
  failNext = 0;
  appSecret = 'test-app-secret';

  describe(): Promise<WhatsAppStatus> {
    return Promise.resolve({
      connected: true,
      number: '+•••• 4567',
      mode: 'cloud',
      reason: null,
    });
  }

  async verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
    if (!signatureHeader?.startsWith('sha256=')) return false;
    const expected = await hashApprovalToken(rawBody, this.appSecret);
    return signatureHeader === `sha256=${expected}`;
  }

  parseInbound(): WhatsAppInbound[] {
    return this.queue.splice(0, this.queue.length);
  }

  sendText(to: string, body: string): Promise<{ messageId: string }> {
    return this.record(to, body, 'text');
  }

  sendButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<{ messageId: string }> {
    return this.record(to, body, 'buttons', buttons);
  }

  markRead(messageId: string): Promise<void> {
    this.readIds.push(messageId);
    return Promise.resolve();
  }

  private record(
    to: string,
    body: string,
    kind: 'text' | 'buttons',
    buttons?: Array<{ id: string; title: string }>,
  ): Promise<{ messageId: string }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new AppError('WHATSAPP_ERROR', 'Simulated WhatsApp failure'));
    }
    this.sent.push({ to, body, kind, ...(buttons ? { buttons } : {}) });
    return Promise.resolve({ messageId: `wa-${this.sent.length}` });
  }
}

export class FakeLinkedInGateway implements LinkedInGateway {
  publishCalls: Array<{ commentary: string; idempotencyKey: string }> = [];
  connected = true;
  needsReauth = false;
  expiresAt: string | null = null;
  failures: Error[] = [];
  url = 'https://www.linkedin.com/feed/update/urn:li:share:999/';

  status(): Promise<LinkedInStatus> {
    return Promise.resolve({
      connected: this.connected && !this.needsReauth,
      label: this.connected ? 'Test Owner' : null,
      expiresAt: this.expiresAt,
      needsReauth: this.needsReauth,
    });
  }

  publish(input: {
    commentary: string;
    idempotencyKey: string;
  }): Promise<{ externalId: string; url: string }> {
    this.publishCalls.push(input);
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    return Promise.resolve({ externalId: 'urn:li:share:999', url: this.url });
  }
}

export class FakeSheetsGateway implements SheetsGateway {
  snapshot: SheetSnapshot = { rows: [], issues: [], sheetLabel: 'Test Sheet' };
  updates: SheetRowUpdate[] = [];
  failReads = false;
  failUpdates = false;
  describe(): Promise<{ connected: boolean; sheetLabel: string; sheetId: string | null }> {
    return Promise.resolve({
      connected: true,
      sheetLabel: this.snapshot.sheetLabel,
      sheetId: 'test-sheet-id',
    });
  }
  readRows(): Promise<SheetSnapshot> {
    if (this.failReads)
      return Promise.reject(new AppError('SHEETS_ERROR', 'Simulated sheets read failure'));
    return Promise.resolve(this.snapshot);
  }
  updateRows(updates: SheetRowUpdate[]): Promise<void> {
    if (this.failUpdates)
      return Promise.reject(new AppError('SHEETS_ERROR', 'Simulated sheets write failure'));
    this.updates.push(...updates);
    return Promise.resolve();
  }
}

export interface Harness {
  services: Services;
  db: MemoryDatabase;
  clock: FixedClock;
  ai: FakeAiProvider;
  email: FakeEmailGateway;
  linkedin: FakeLinkedInGateway;
  whatsapp: FakeWhatsAppGateway;
  sheets: FakeSheetsGateway;
  config: AppConfig;
  env: Record<string, string>;
  /** Phase 10: every webhook request the app tried to send, in order. */
  webhooks: Array<{ url: string; headers: Record<string, string>; body: string }>;
  /** Queue the responses those sends should get (an Error = network failure). */
  webhookResponses: Array<{ status: number; body: string } | Error>;
}

export interface HarnessOptions {
  now?: string;
  /** Enables the WhatsApp channel in the test config (default: off). */
  whatsapp?: boolean;
  settings?: Partial<Settings>;
  sheetRows?: Array<{ date: string; topic: string; keyPoints?: string; contentType?: string }>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = new FixedClock(new Date(options.now ?? '2026-11-16T03:05:00Z'));
  const db = new MemoryDatabase(clock, {
    ...defaultSettings({
      ownerTimezone: 'Asia/Karachi',
      generationTime: '08:00',
      publishTime: '09:30',
    }),
    ...options.settings,
  });
  const ai = new FakeAiProvider();
  const email = new FakeEmailGateway();
  const linkedin = new FakeLinkedInGateway();
  const whatsapp = new FakeWhatsAppGateway();
  const sheets = new FakeSheetsGateway();
  const config = testConfig(options.whatsapp ? TEST_WHATSAPP_ENV : {});
  const cipher = createCipher(
    new Uint8Array(Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')),
  );

  sheets.snapshot = {
    sheetLabel: 'Test Sheet',
    issues: [],
    rows: (
      options.sheetRows ?? [{ date: '2026-11-16', topic: 'Idempotency keys for agent tool calls' }]
    ).map((row, index) => ({
      rowNumber: index + 2,
      date: row.date,
      topic: row.topic,
      contentType: row.contentType ?? 'insight',
      keyPoints:
        row.keyPoints ?? 'Deduped retried tool calls with a hash of tool name and arguments.',
      targetAudience: 'Engineers',
      status: 'pending',
      approval: '',
      generatedPost: null,
      hashtags: null,
      publishTime: null,
      publishedUrl: null,
    })),
  };

  const webhooks: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  /** Queued webhook responses: an Error means "network failure", a value is the HTTP response. */
  const webhookResponses: Array<{ status: number; body: string } | Error> = [];

  const services: Services = {
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
    // Tests record webhook sends instead of making them; `webhooks` collects what would have gone out.
    webhookSender: async (url, init) => {
      webhooks.push({ url, headers: init.headers, body: init.body });
      const next = webhookResponses.shift();
      if (next instanceof Error) throw next;
      return next ?? { status: 200, body: 'ok' };
    },
  };

  return {
    services,
    db,
    clock,
    ai,
    webhooks,
    webhookResponses,
    email,
    linkedin,
    whatsapp,
    sheets,
    config,
    env: {
      ...(options.whatsapp ? TEST_WHATSAPP_ENV : {}),
      APP_ENV: 'test',
      APP_BASE_URL: 'https://automation.test',
      OWNER_EMAIL: 'owner@example.com',
      APPROVAL_TOKEN_SECRET: 'test-approval-secret-value-with-enough-length',
      TOKEN_ENCRYPTION_KEY: TEST_KEY,
      SERVICES_MODE: 'local',
      CRON_SECRET: 'test-cron-secret-with-enough-length',
      ALLOW_DEV_BYPASS: 'true',
    },
  };
}

export function extractTokenFromEmail(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]{43})/);
  if (!match) throw new Error('No approval token found in email');
  return match[1]!;
}

export function approvalEmail(harness: Harness): EmailMessage & { messageId: string } {
  const email = harness.email.sent.find((message) => message.html.includes('/approve/?token='));
  if (!email) throw new Error('No approval email was sent');
  return email;
}

export type { Database };
