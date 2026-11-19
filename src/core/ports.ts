import type {
  ApiKeyRecord,
  NewApiKey as ApiKeyInput,
  NewWebhookEndpoint,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointPatch,
} from './omni';
import type { NewPushSubscription, PushSubscription } from './push';
import type {
  Approval,
  ApprovalStatus,
  DraftContent,
  DraftVariant,
  Integration,
  IntegrationProvider,
  ISODate,
  ISOInstant,
  Job,
  JobStatus,
  LogEntry,
  LogLevel,
  NewPost,
  NewPostVariant,
  NewTopic,
  Post,
  PostStatus,
  PostVariant,
  SchedulerState,
  Settings,
  Topic,
  TopicStatus,
} from './types';

/** Injectable clock so scheduling and expiry logic is testable. */
export interface Clock {
  now(): Date;
}

export interface SettingsPatch {
  ownerTimezone?: string;
  generationTime?: string;
  publishTime?: string;
  publishDays?: number[];
  respectPublishTime?: boolean;
  autoPublishOnApproval?: boolean;
  approvalTtlHours?: number;
  aiProvider?: string;
  aiModel?: string;
  brandVoice?: string;
  writingInstructions?: string;
  hashtagMin?: number;
  hashtagMax?: number;
  maxPostChars?: number;
  emailNotifications?: boolean;
  publishTimes?: string[];
}

export interface TopicFilter {
  statuses?: TopicStatus[];
  from?: ISODate;
  to?: ISODate;
  slotIndex?: number;
  limit?: number;
}

export interface PostFilter {
  statuses?: PostStatus[];
  from?: ISODate;
  to?: ISODate;
  slotIndex?: number;
  limit?: number;
  offset?: number;
}

export interface ApprovalFilter {
  statuses?: ApprovalStatus[];
  limit?: number;
}

export interface JobFilter {
  statuses?: JobStatus[];
  limit?: number;
}

export interface LogFilter {
  level?: LogLevel;
  event?: string;
  limit?: number;
}

export interface IntegrationPatch {
  status?: Integration['status'];
  accountLabel?: string | null;
  scopes?: string[];
  accessTokenEnc?: string | null;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: ISOInstant | null;
  metadata?: Record<string, unknown>;
  lastCheckedAt?: ISOInstant | null;
  lastError?: string | null;
}

export type PostPatch = Partial<
  Pick<
    Post,
    | 'status'
    | 'hook'
    | 'body'
    | 'hashtags'
    | 'fullText'
    | 'charCount'
    | 'errorMessage'
    | 'externalId'
    | 'publishedUrl'
    | 'publishedAt'
    | 'editedByOwner'
    | 'model'
    | 'provider'
    | 'source'
  >
>;

export type TopicPatch = Partial<
  Pick<Topic, 'status' | 'lastError' | 'sheetRowNumber' | 'topicDate'>
>;

export type JobPatch = Partial<
  Pick<
    Job,
    | 'status'
    | 'runAt'
    | 'lockedUntil'
    | 'lastError'
    | 'externalId'
    | 'postUrl'
    | 'publishedAt'
    | 'attempts'
  >
>;

export type ApprovalPatch = Partial<
  Pick<Approval, 'emailSentAt' | 'emailMessageId' | 'status' | 'usedAt' | 'action'>
>;

export interface NewApproval {
  postId: string;
  tokenHash: string;
  expiresAt: ISOInstant;
}

export interface NewJob {
  postId: string;
  runAt: ISOInstant;
  status?: JobStatus;
}

export interface NewLogEntry {
  level: LogLevel;
  event: string;
  message?: string | null;
  context?: Record<string, unknown>;
  actor?: string;
  runId?: string | null;
}

export interface SchedulerPatch {
  lastGenerationDate?: ISODate | null;
  lastGenerationAt?: ISOInstant | null;
  lastGenerationStatus?: SchedulerState['lastGenerationStatus'];
  generationAttempts?: number;
  lastPublishSweepAt?: ISOInstant | null;
}

/** Persistence port. Implemented by PostgREST (production) and an in-memory store (tests/dev). */
export interface Database {
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;

  listTopics(filter?: TopicFilter): Promise<Topic[]>;
  getTopic(id: string): Promise<Topic | null>;
  createTopic(input: NewTopic): Promise<Topic>;
  updateTopic(id: string, patch: TopicPatch): Promise<Topic>;
  upsertTopics(topics: NewTopic[]): Promise<{ inserted: number; skipped: number }>;
  /** Claims the next usable topic for a date and slot. Slot 0 is the single-post case. */
  claimDailyTopic(topicDate: ISODate, maxAttempts: number, slotIndex?: number): Promise<Topic | null>;

  createPost(input: NewPost): Promise<Post>;
  getPost(id: string): Promise<Post | null>;
  getPostByDate(runDate: ISODate, slotIndex?: number): Promise<Post | null>;
  listPosts(filter?: PostFilter): Promise<Post[]>;
  countPosts(statuses?: PostStatus[]): Promise<number>;
  updatePost(id: string, patch: PostPatch): Promise<Post>;
  claimPostForPublish(id: string): Promise<Post | null>;

  /** Stores the draft options produced by one generation call; index 0 becomes the live draft. */
  createVariants(postId: string, variants: NewPostVariant[]): Promise<PostVariant[]>;
  listVariants(postId: string): Promise<PostVariant[]>;
  /** Marks one variant selected and discards the rest. */
  selectVariant(postId: string, variantId: string, at: ISOInstant): Promise<PostVariant>;
  /** Deletes discarded variants older than the cutoff. Returns how many were removed. */
  pruneVariants(before: ISOInstant): Promise<number>;

  createApproval(input: NewApproval): Promise<Approval>;
  getApproval(id: string): Promise<Approval | null>;
  getApprovalByTokenHash(tokenHash: string): Promise<Approval | null>;
  getActiveApprovalForPost(postId: string): Promise<Approval | null>;
  listApprovals(filter?: ApprovalFilter): Promise<Approval[]>;
  updateApproval(id: string, patch: ApprovalPatch): Promise<Approval>;
  consumeApproval(tokenHash: string, action: 'approve' | 'reject'): Promise<Approval | null>;
  expireStaleApprovals(): Promise<{ expiredApprovals: number; expiredPosts: number }>;

  createJob(input: NewJob): Promise<Job>;
  getJob(id: string): Promise<Job | null>;
  getJobByPost(postId: string): Promise<Job | null>;
  listJobs(filter?: JobFilter): Promise<Job[]>;
  claimDueJobs(limit: number): Promise<Job[]>;
  updateJob(id: string, patch: JobPatch): Promise<Job>;
  recoverStuckJobs(): Promise<number>;

  getIntegration(provider: IntegrationProvider): Promise<Integration | null>;
  listIntegrations(): Promise<Integration[]>;
  upsertIntegration(provider: IntegrationProvider, patch: IntegrationPatch): Promise<Integration>;

  insertLog(entry: NewLogEntry): Promise<void>;
  listLogs(filter?: LogFilter): Promise<LogEntry[]>;

  getSchedulerState(): Promise<SchedulerState>;
  updateSchedulerState(patch: SchedulerPatch): Promise<SchedulerState>;
  claimGenerationDay(date: ISODate, maxAttempts: number): Promise<boolean>;
  /** Phase 10: the same claim, per (date, slot), so two posts a day do not block each other. */
  claimGenerationSlot(date: ISODate, slotIndex: number, maxAttempts: number): Promise<boolean>;
  finishGenerationSlot(date: ISODate, slotIndex: number, status: string): Promise<void>;

  /** Short code that maps a WhatsApp message back to a post (stored hashed, single use). */
  createWhatsAppCode(input: {
    codeHash: string;
    postId: string;
    expiresAt: ISOInstant;
  }): Promise<void>;
  getWhatsAppCode(codeHash: string): Promise<WhatsAppCodeRecord | null>;
  consumeWhatsAppCode(codeHash: string): Promise<{ postId: string } | null>;
  /** Returns false when the message id was already processed (webhook retries). */
  recordWhatsAppMessage(input: {
    messageId: string;
    from: string;
    receivedAt: ISOInstant;
  }): Promise<boolean>;

  /** Phase 10: hashed API keys (the plaintext never reaches the database). */
  createApiKey(input: ApiKeyInput): Promise<ApiKeyRecord>;
  listApiKeys(): Promise<ApiKeyRecord[]>;
  findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  revokeApiKey(id: string, at: ISOInstant): Promise<ApiKeyRecord>;
  touchApiKey(id: string, at: ISOInstant): Promise<void>;

  /** Phase 10: webhook endpoints and their delivery backlog. */
  listWebhookEndpoints(options?: { activeOnly?: boolean }): Promise<WebhookEndpoint[]>;
  createWebhookEndpoint(input: NewWebhookEndpoint): Promise<WebhookEndpoint>;
  updateWebhookEndpoint(
    id: string,
    patch: WebhookEndpointPatch,
  ): Promise<WebhookEndpoint>;
  deleteWebhookEndpoint(id: string): Promise<void>;
  /**
   * Queues one delivery per endpoint. Returns false when this event id was already queued for that
   * endpoint, which is what makes a retried tick idempotent.
   */
  enqueueWebhookDelivery(input: {
    endpointId: string;
    event: string;
    eventId: string;
    payload: Record<string, unknown>;
    nextAttemptAt: ISOInstant;
  }): Promise<boolean>;
  claimWebhookDeliveries(limit: number): Promise<WebhookDelivery[]>;
  updateWebhookDelivery(
    id: string,
    patch: {
      status: WebhookDelivery['status'];
      attempts: number;
      nextAttemptAt: ISOInstant;
      responseStatus: number | null;
      responseBody: string | null;
      deliveredAt: ISOInstant | null;
    },
  ): Promise<void>;
  listWebhookDeliveries(options?: {
    endpointId?: string;
    statuses?: WebhookDelivery['status'][];
    limit?: number;
  }): Promise<WebhookDelivery[]>;

  /** Phase 10: web push devices. Endpoint is unique, so a re-subscribe updates the same row. */
  savePushSubscription(input: NewPushSubscription): Promise<PushSubscription>;
  listPushSubscriptions(): Promise<PushSubscription[]>;
  deletePushSubscription(endpoint: string): Promise<void>;
  recordPushResult(
    id: string,
    result: { ok: boolean; status?: number; error?: string; at: ISOInstant },
  ): Promise<void>;

  createOAuthState(input: {
    state: string;
    provider: string;
    expiresAt: ISOInstant;
    redirectAfter?: string | null;
  }): Promise<void>;
  consumeOAuthState(
    state: string,
  ): Promise<{ provider: string; redirectAfter: string | null } | null>;
}

export interface GeneratePostInput {
  topic: string;
  contentType: string;
  keyPoints: string | null;
  targetAudience: string | null;
  brandVoice: string;
  writingInstructions: string;
  hashtagMin: number;
  hashtagMax: number;
  maxChars: number;
  recentHooks: string[];
  /** Phase 7: formatted hook-library guidance from the owner's own outcomes ('' when empty). */
  hookLibrary?: string;
  /**
   * Phase 10: how many drafts already exist for this date. A real model reads `recentHooks` and never
   * repeats itself; a deterministic offline provider needs the number to pick a different angle.
   */
  slotIndex?: number;
}

/** Provider-independent AI port. Add a new provider by implementing this interface. */
export interface AiProvider {
  readonly id: string;
  readonly model: string;
  generatePost(input: GeneratePostInput): Promise<DraftContent>;
  /**
   * Optional: several distinct drafts from ONE request, so the free-tier quota is spent once
   * instead of once per variant. Providers without it fall back to a single draft.
   */
  generateVariants?(input: GeneratePostInput, count: number): Promise<DraftVariant[]>;
  /**
   * Optional (Phase 6): one request that proposes several upcoming topics. Returns the raw
   * JSON text - parsing and duplicate filtering live in src/core/suggestions.ts so they are
   * testable without any provider.
   */
  suggestTopics?(
    input: { systemInstruction: string; prompt: string },
    count: number,
  ): Promise<string>;
}

export interface SheetTopicRow {
  rowNumber: number;
  date: ISODate;
  topic: string;
  contentType: string;
  keyPoints: string | null;
  targetAudience: string | null;
  status: string;
  approval: string;
  generatedPost: string | null;
  hashtags: string | null;
  publishTime: string | null;
  publishedUrl: string | null;
}

export interface SheetRowIssue {
  rowNumber: number;
  reason: string;
}

export interface SheetSnapshot {
  rows: SheetTopicRow[];
  issues: SheetRowIssue[];
  sheetLabel: string;
}

export interface SheetRowUpdate {
  rowNumber: number;
  status?: string;
  generatedPost?: string;
  hashtags?: string;
  approval?: string;
  publishTime?: string;
  publishedUrl?: string;
}

export interface SheetsGateway {
  describe(): Promise<{ connected: boolean; sheetLabel: string; sheetId: string | null }>;
  readRows(): Promise<SheetSnapshot>;
  updateRows(updates: SheetRowUpdate[]): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailGateway {
  describe(): Promise<{ connected: boolean; fromEmail: string }>;
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export interface LinkedInPublishInput {
  commentary: string;
  idempotencyKey: string;
}

export interface LinkedInStatus {
  connected: boolean;
  label: string | null;
  expiresAt: ISOInstant | null;
  needsReauth: boolean;
}

export interface LinkedInGateway {
  status(): Promise<LinkedInStatus>;
  publish(input: LinkedInPublishInput): Promise<{ externalId: string; url: string }>;
}

/* ------------------------------------------------------------------ WhatsApp */

export interface WhatsAppStatus {
  connected: boolean;
  /** Masked business number, safe to render in the dashboard. */
  number: string | null;
  mode: 'cloud' | 'disabled';
  reason: string | null;
}

export interface WhatsAppInbound {
  /** 'reply' = the user tapped an interactive button. */
  kind: 'text' | 'reply';
  messageId: string;
  /** Sender's WhatsApp id, digits only. */
  from: string;
  /** Message text, or the button id for a reply. */
  text: string | null;
  timestamp: string;
}

export interface WhatsAppCodeRecord {
  postId: string;
  expiresAt: ISOInstant;
  usedAt: ISOInstant | null;
}

/**
 * WhatsApp Cloud API port (Meta, official). The webhook is verified with the app secret,
 * so nothing in the rest of the system has to trust an unauthenticated caller.
 */
export interface WhatsAppGateway {
  readonly id: string;
  describe(): Promise<WhatsAppStatus>;
  verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean>;
  parseInbound(payload: unknown): WhatsAppInbound[];
  sendText(to: string, body: string): Promise<{ messageId: string }>;
  sendButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<{ messageId: string }>;
  markRead(messageId: string): Promise<void>;
}

export interface Cipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(payload: string): Promise<string>;
}
