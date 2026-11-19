export type ISODate = string;
export type ISOInstant = string;

export const POST_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'publishing',
  'published',
  'failed',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const TOPIC_STATUSES = ['pending', 'claimed', 'generated', 'skipped', 'failed'] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const JOB_STATUSES = [
  'queued',
  'processing',
  'published',
  'failed',
  'manual_required',
  'canceled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const INTEGRATION_PROVIDERS = ['google_sheets', 'linkedin', 'resend', 'gemini'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ['connected', 'disconnected', 'error', 'needs_reauth'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const CONTENT_TYPES = [
  'insight',
  'story',
  'how-to',
  'opinion',
  'case-note',
  'list',
  'question',
] as const;

export interface Settings {
  ownerTimezone: string;
  generationTime: string;
  publishTime: string;
  publishDays: number[];
  respectPublishTime: boolean;
  autoPublishOnApproval: boolean;
  approvalTtlHours: number;
  aiProvider: string;
  aiModel: string;
  brandVoice: string;
  writingInstructions: string;
  hashtagMin: number;
  hashtagMax: number;
  maxPostChars: number;
  emailNotifications: boolean;
  /**
   * Phase 10: wall-clock times of every publishing slot ('10:30', '15:00'). Empty or one entry means the
   * owner still has a single daily slot, which is what every earlier phase assumed.
   */
  publishTimes: string[];
  updatedAt: ISOInstant;
}

export interface Topic {
  id: string;
  sheetRowNumber: number | null;
  topicDate: ISODate;
  /**
   * Phase 10: which post of the day this topic feeds (0-based, 0-4).
   *
   * Optional on purpose. Every topic written before this phase was slot 0, and any code that predates
   * it - a planner, a test fixture, an import - keeps compiling without being touched. Read it through
   * `slotOfTopic()` rather than directly, so "missing" and "first slot" mean the same thing everywhere.
   */
  slotIndex?: number;
  topic: string;
  contentType: string;
  keyPoints: string | null;
  targetAudience: string | null;
  status: TopicStatus;
  attempts: number;
  lastError: string | null;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

/** Optional `slotIndex`: every caller that predates multiple slots writes slot 0. */
export type NewTopic = Omit<
  Topic,
  'id' | 'status' | 'attempts' | 'lastError' | 'createdAt' | 'updatedAt' | 'slotIndex'
> & {
  slotIndex?: number;
};

export interface Post {
  id: string;
  topicId: string | null;
  runDate: ISODate;
  /**
   * Phase 10: which post of the day (0-4). Optional for the same reason as `Topic.slotIndex`: posts
   * written before this phase are slot 0, and a fixture that predates it must keep compiling. Read it
   * through `slotOfPost()`.
   */
  slotIndex?: number;
  hook: string;
  body: string;
  hashtags: string[];
  fullText: string;
  charCount: number;
  provider: string;
  model: string;
  status: PostStatus;
  source: string;
  editedByOwner: boolean;
  errorMessage: string | null;
  externalId: string | null;
  publishedUrl: string | null;
  publishedAt: ISOInstant | null;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export interface NewPost {
  topicId: string | null;
  runDate: ISODate;
  slotIndex?: number;
  hook: string;
  body: string;
  hashtags: string[];
  fullText: string;
  charCount: number;
  provider: string;
  model: string;
  status: PostStatus;
  source: string;
}

export interface Approval {
  id: string;
  postId: string;
  tokenHash: string;
  status: ApprovalStatus;
  action: string | null;
  expiresAt: ISOInstant;
  usedAt: ISOInstant | null;
  emailSentAt: ISOInstant | null;
  emailMessageId: string | null;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export interface Job {
  id: string;
  postId: string;
  runAt: ISOInstant;
  status: JobStatus;
  attempts: number;
  lockedUntil: ISOInstant | null;
  lastError: string | null;
  externalId: string | null;
  postUrl: string | null;
  publishedAt: ISOInstant | null;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export interface Integration {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  accountLabel: string | null;
  scopes: string[];
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: ISOInstant | null;
  metadata: Record<string, unknown>;
  lastCheckedAt: ISOInstant | null;
  lastError: string | null;
  updatedAt: ISOInstant;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  runId: string | null;
  level: LogLevel;
  event: string;
  message: string | null;
  context: Record<string, unknown>;
  actor: string;
  createdAt: ISOInstant;
}

export interface SchedulerState {
  lastGenerationDate: ISODate | null;
  lastGenerationAt: ISOInstant | null;
  lastGenerationStatus: string | null;
  generationAttempts: number;
  lastPublishSweepAt: ISOInstant | null;
  updatedAt: ISOInstant;
}

/** Structured content produced by an AI provider before final formatting. */
export interface DraftContent {
  hook: string;
  body: string;
  hashtags: string[];
}

/** One of the drafts generated in a single call, labelled by the angle it took. */
export interface DraftVariant extends DraftContent {
  angle: string;
}

/**
 * A stored draft option. The chosen one is copied into the post, so the post stays the
 * single source of truth for approvals and publishing.
 */
export interface PostVariant {
  id: string;
  postId: string;
  variantIndex: number;
  angle: string;
  hook: string;
  body: string;
  hashtags: string[];
  fullText: string;
  charCount: number;
  selected: boolean;
  discardedAt: ISOInstant | null;
  createdAt: ISOInstant;
}

export type NewPostVariant = Omit<
  PostVariant,
  'id' | 'postId' | 'selected' | 'discardedAt' | 'createdAt'
>;

export interface FormatResult {
  fullText: string;
  charCount: number;
  hashtags: string[];
  hook: string;
  body: string;
  issues: string[];
}

export interface ScheduledSlot {
  localDate: ISODate;
  /** Which post of the day this is (0-based). Single-slot days only ever use 0. */
  slotIndex: number;
  generationAt: ISOInstant;
  publishAt: ISOInstant;
  isGenerationDay: boolean;
}

/** One day's worth of slots, in order. */
export interface DaySlots {
  localDate: ISODate;
  slots: ScheduledSlot[];
  isGenerationDay: boolean;
}

/** One day of dashboard activity: drafts created, posts published, drafts that failed. */
export interface ActivityPoint {
  date: string;
  generated: number;
  published: number;
  /**
   * Failures counted per day. Optional because a tree without a failure count still produces these
   * points; the dashboard chart treats a missing value as zero.
   */
  failed?: number;
}

/** Seven-day comparison used by the overview tiles. */
export interface Trend {
  current: number;
  previous: number;
}
