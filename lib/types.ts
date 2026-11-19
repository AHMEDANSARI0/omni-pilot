export interface PostVariantDto {
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
  discardedAt: string | null;
  createdAt: string;
}

export interface PostDto {
  id: string;
  topicId: string | null;
  runDate: string;
  hook: string;
  body: string;
  hashtags: string[];
  fullText: string;
  charCount: number;
  provider: string;
  model: string;
  status: string;
  source: string;
  editedByOwner: boolean;
  errorMessage: string | null;
  externalId: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present when the API is asked with `variants=1` (draft comparison view). */
  variants?: PostVariantDto[];
}

export interface TopicDto {
  id: string;
  sheetRowNumber: number | null;
  topicDate: string;
  topic: string;
  contentType: string;
  keyPoints: string | null;
  targetAudience: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
}

export interface JobDto {
  id: string;
  postId: string;
  runAt: string;
  status: string;
  attempts: number;
  lastError: string | null;
  postUrl: string | null;
  publishedAt: string | null;
}

export interface ApprovalDto {
  id: string;
  postId: string;
  status: string;
  action: string | null;
  expiresAt: string;
  usedAt: string | null;
  emailSentAt: string | null;
}

export interface LogDto {
  id: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  message: string | null;
  context: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

export interface SettingsDto {
  ownerTimezone: string;
  generationTime: string;
  publishTime: string;
  /** Phase 10: every slot of the day. One entry = a single daily post. */
  publishTimes: string[];
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
  updatedAt: string;
}

export interface ScheduledSlotDto {
  localDate: string;
  slotIndex: number;
  generationAt: string;
  publishAt: string;
  isGenerationDay: boolean;
}

export interface ScheduleDto {
  now: string;
  localDate: string;
  localTime: string;
  settings: SettingsDto;
  generationDueNow: boolean;
  generationReason: string;
  todaySlot: ScheduledSlotDto;
  nextSlot: ScheduledSlotDto | null;
  schedulerState: {
    lastGenerationDate: string | null;
    lastGenerationAt: string | null;
    lastGenerationStatus: string | null;
    generationAttempts: number;
    lastPublishSweepAt: string | null;
  };
  queuedJobs: number;
  dueJobs: number;
  recentRuns?: LogDto[];
}

export interface ActivityPointDto {
  date: string;
  generated: number;
  published: number;
  failed: number;
}

/** Phase 7 - one hook from the post history, with the outcome that decided its bucket. */
export interface HookRecordDto {
  hook: string;
  outcome: 'published' | 'approved' | 'pending' | 'rejected' | 'failed';
  runDate: string;
  pattern: string;
}

export interface HookLibraryDto {
  windowStart: string;
  windowEnd: string;
  /** Similarity threshold used by duplicate protection, 0..1. */
  threshold: number;
  proven: HookRecordDto[];
  waiting: HookRecordDto[];
  rejected: HookRecordDto[];
  patterns: Array<{ pattern: string; count: number }>;
  summary: string;
  /** The exact text added to the generation prompt ('' when there is nothing to say). */
  promptBlock: string;
}

/** Reply time on approval emails, measured from decision rows (never estimated). */
export interface ApprovalLagDto {
  medianHours: number | null;
  sample: number;
}

export interface TrendDto {
  current: number;
  previous: number;
}

export interface SuggestedTopicDto {
  topicDate: string;
  topic: string;
  contentType: string;
  keyPoints: string;
  targetAudience: string;
  rationale: string;
  duplicateOf: string | null;
}

export interface SuggestionResultDto {
  suggestions: SuggestedTopicDto[];
  skipped: Array<{ topic: string; reason: string }>;
  windowStart: string;
  windowEnd: string;
  provider: string;
  model: string;
}

export interface CalendarDayDto {
  date: string;
  weekday: number;
  isPublishingDay: boolean;
  isToday: boolean;
  isPast: boolean;
  kind: 'published' | 'scheduled' | 'failed' | 'pending' | 'open';
  title: string;
  postId: string | null;
  topicId: string | null;
  publishedUrl: string | null;
  status: string | null;
}

export interface CalendarMonthDto {
  month: string;
  label: string;
  today: string;
  timezone: string;
  monthStart: string;
  monthEnd: string;
  gridStart: string;
  gridEnd: string;
  weeks: CalendarDayDto[][];
  totals: {
    published: number;
    scheduled: number;
    failed: number;
    pending: number;
    openPublishingDays: number;
  };
  gaps: string[];
}

export interface SummaryDto {
  pendingApprovals: number;
  failed: number;
  nextRunAt: string | null;
  localDate: string;
}

export interface OverviewDto {
  stats: {
    total: number;
    pendingApprovals: number;
    published: number;
    failed: number;
    rejected: number;
    approved: number;
    expired: number;
  };
  schedule: ScheduleDto;
  integrations: {
    googleSheets: { connected: boolean; sheetLabel: string; sheetId: string | null };
    linkedin: {
      connected: boolean;
      label: string | null;
      expiresAt: string | null;
      needsReauth: boolean;
    };
    email: { connected: boolean; fromEmail: string };
    ai: { provider: string; model: string };
  };
  latestPosts: PostDto[];
  upcomingTopics: TopicDto[];
  recentLogs: LogDto[];
  series: ActivityPointDto[];
  trend: { generated: TrendDto; published: TrendDto };
  approvalLag: ApprovalLagDto;
  mode: { appEnv: string; servicesMode: string; devBypass: boolean };
}

export interface ApprovalPreviewDto {
  state: 'actionable' | 'expired' | 'used' | 'invalid';
  message: string;
  post: PostDto | null;
  approval: ApprovalDto | null;
  action: string | null;
  expiresAt: string | null;
}

export interface DecisionResponseDto {
  action: string;
  postStatus: string;
  publish: { status: string; jobId: string | null; url: string | null; message: string } | null;
  post: { id: string; runDate: string; publishedUrl: string | null; status: string };
}

export interface IntegrationsDto {
  servicesMode: string;
  googleSheets: {
    connected: boolean;
    sheetLabel: string;
    sheetId: string | null;
    lastError: string | null;
    configured: boolean;
  };
  linkedin: {
    connected: boolean;
    label: string | null;
    expiresAt: string | null;
    needsReauth: boolean;
    configured: boolean;
  };
  email: { connected: boolean; fromEmail: string; provider: string };
  ai: { provider: string; model: string };
}
