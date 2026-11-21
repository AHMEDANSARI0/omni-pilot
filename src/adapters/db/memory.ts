import { AppError } from '@/src/core/errors';
import { defaultSettings } from '@/src/core/defaults';
import { slotOfPost, slotOfTopic } from '@/src/core/slot';
import type {
  ApiKeyRecord,
  NewApiKey as ApiKeyInput,
  NewWebhookEndpoint,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointPatch,
} from '@/src/core/omni';
import type { NewPushSubscription, PushSubscription } from '@/src/core/push';
import type {
  Approval,
  ApprovalStatus,
  Integration,
  IntegrationProvider,
  ISODate,
  Job,
  LogEntry,
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
} from '@/src/core/types';
import type {
  ApprovalFilter,
  ApprovalPatch,
  Clock,
  Database,
  IntegrationPatch,
  JobFilter,
  JobPatch,
  LogFilter,
  NewApproval,
  NewJob,
  NewLogEntry,
  PostFilter,
  PostPatch,
  SchedulerPatch,
  SettingsPatch,
  TopicFilter,
  TopicPatch,
} from '@/src/core/ports';

/**
 * In-memory Database implementation.
 *
 * Used by the test suite and by `SERVICES_MODE=local` for dashboard development without
 * Supabase credentials. It is never selectable in production: config loading forces
 * `servicesMode = 'live'` when APP_ENV=production and the runtime refuses to boot with
 * a local database in production.
 */
export class MemoryDatabase implements Database {
  private settings: Settings;
  private topics = new Map<string, Topic>();
  private posts = new Map<string, Post>();
  private variants = new Map<string, PostVariant>();
  private approvals = new Map<string, Approval>();
  private jobs = new Map<string, Job>();
  private integrations = new Map<IntegrationProvider, Integration>();
  private logs: LogEntry[] = [];
  private oauthStates = new Map<
    string,
    { provider: string; redirectAfter: string | null; expiresAt: string }
  >();
  private whatsappCodes = new Map<
    string,
    { postId: string; expiresAt: string; usedAt: string | null }
  >();
  private whatsappMessages = new Set<string>();
  private scheduler: SchedulerState;
  /** Phase 10: generation claim per (date, slot), so two posts a day do not block each other. */
  private generationClaims = new Map<string, { attempts: number; status: string }>();
  private apiKeys = new Map<string, ApiKeyRecord>();
  private webhookEndpoints = new Map<string, WebhookEndpoint>();
  private webhookDeliveries = new Map<string, WebhookDelivery>();
  private pushSubscriptions = new Map<string, PushSubscription>();
  private logSequence = 0;

  constructor(
    private readonly clock: Clock,
    overrides: Partial<Settings> = {},
  ) {
    this.settings = defaultSettings(overrides);
    this.scheduler = {
      lastGenerationDate: null,
      lastGenerationAt: null,
      lastGenerationStatus: null,
      generationAttempts: 0,
      lastPublishSweepAt: null,
      updatedAt: this.now(),
    };
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  async getSettings(): Promise<Settings> {
    return { ...this.settings };
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const next = { ...this.settings, ...patch };
    // Phase 10 invariants, mirrored from the PostgREST adapter so both behave identically:
    // slot 0 is the canonical publish time, and a day can never hold more than five slots.
    if (patch.publishTimes !== undefined) {
      const times = [...new Set(patch.publishTimes.filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))]
        .sort()
        .slice(0, 5);
      next.publishTimes = times;
      if (times[0]) next.publishTime = times[0];
    } else if (patch.publishTime !== undefined) {
      next.publishTimes = [patch.publishTime];
    }
    this.settings = { ...next, updatedAt: this.now() };
    return { ...this.settings };
  }

  async listTopics(filter: TopicFilter = {}): Promise<Topic[]> {
    return [...this.topics.values()]
      .filter((topic) => (filter.statuses ? filter.statuses.includes(topic.status) : true))
      .filter((topic) =>
        filter.slotIndex === undefined ? true : slotOfTopic(topic) === filter.slotIndex,
      )
      .filter((topic) => (filter.from ? topic.topicDate >= filter.from : true))
      .filter((topic) => (filter.to ? topic.topicDate <= filter.to : true))
      .sort((a, b) =>
        a.topicDate === b.topicDate
          ? a.createdAt.localeCompare(b.createdAt)
          : b.topicDate.localeCompare(a.topicDate),
      )
      .slice(0, filter.limit ?? 200);
  }

  async getTopic(id: string): Promise<Topic | null> {
    return this.topics.get(id) ?? null;
  }

  async createTopic(input: NewTopic): Promise<Topic> {
    const duplicate = [...this.topics.values()].find(
      (topic) =>
        topic.topicDate === input.topicDate &&
        topic.topic.toLowerCase() === input.topic.toLowerCase() &&
        // The real index is `(topic_date, topic)`, so two slots of one day with the same wording do collide
        // in PostgreSQL. The memory adapter has to fail in exactly the same places the database does, or a
        // unit test passes and the live app returns 409 - which is how this one was found.
        slotOfTopic(topic) === (input.slotIndex ?? 0),
    );
    if (duplicate) {
      throw new AppError(
        'CONFLICT',
        `Topic already exists for ${input.topicDate} slot ${input.slotIndex ?? 0}: ${input.topic}`,
      );
    }
    const now = this.now();
    const topic: Topic = {
      ...input,
      slotIndex: input.slotIndex ?? 0,
      id: crypto.randomUUID(),
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.topics.set(topic.id, topic);
    return topic;
  }

  async updateTopic(id: string, patch: TopicPatch): Promise<Topic> {
    const existing = this.topics.get(id);
    if (!existing) throw new AppError('NOT_FOUND', `Topic ${id} not found`);
    const updated = { ...existing, ...patch, updatedAt: this.now() };
    this.topics.set(id, updated);
    return updated;
  }

  async upsertTopics(topics: NewTopic[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const input of topics) {
      const duplicate = [...this.topics.values()].find(
        (topic) =>
          topic.topicDate === input.topicDate &&
          topic.topic.trim().toLowerCase() === input.topic.trim().toLowerCase(),
      );
      if (duplicate) {
        skipped += 1;
        if (input.sheetRowNumber !== null && duplicate.sheetRowNumber !== input.sheetRowNumber) {
          this.topics.set(duplicate.id, {
            ...duplicate,
            sheetRowNumber: input.sheetRowNumber,
            updatedAt: this.now(),
          });
        }
        continue;
      }
      const now = this.now();
      const topic: Topic = {
        ...input,
        slotIndex: input.slotIndex ?? 0,
        id: crypto.randomUUID(),
        status: 'pending',
        attempts: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      this.topics.set(topic.id, topic);
      inserted += 1;
    }
    return { inserted, skipped };
  }

  async claimDailyTopic(
    topicDate: ISODate,
    maxAttempts: number,
    slotIndex = 0,
  ): Promise<Topic | null> {
    const candidates = [...this.topics.values()]
      .filter((topic) => topic.topicDate === topicDate && slotOfTopic(topic) === slotIndex)
      .filter(
        (topic) =>
          topic.status === 'pending' ||
          (topic.status === 'failed' && topic.attempts < maxAttempts) ||
          (topic.status === 'claimed' && topic.attempts < maxAttempts),
      )
      .sort((a, b) => {
        const rowA = a.sheetRowNumber ?? Number.MAX_SAFE_INTEGER;
        const rowB = b.sheetRowNumber ?? Number.MAX_SAFE_INTEGER;
        return rowA === rowB ? a.createdAt.localeCompare(b.createdAt) : rowA - rowB;
      });
    const candidate = candidates[0];
    if (!candidate) return null;
    const claimed: Topic = {
      ...candidate,
      status: 'claimed',
      attempts: candidate.attempts + 1,
      updatedAt: this.now(),
    };
    this.topics.set(claimed.id, claimed);
    return claimed;
  }

  async createPost(input: NewPost): Promise<Post> {
    const slotIndex = input.slotIndex ?? 0;
    const duplicate = [...this.posts.values()].find(
      (post) => post.runDate === input.runDate && slotOfPost(post) === slotIndex,
    );
    if (duplicate) {
      throw new AppError(
        'CONFLICT',
        `A post already exists for ${input.runDate}${slotIndex > 0 ? ` slot ${slotIndex}` : ''}`,
      );
    }
    const now = this.now();
    const post: Post = {
      ...input,
      slotIndex,
      id: crypto.randomUUID(),
      editedByOwner: false,
      errorMessage: null,
      externalId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.posts.set(post.id, post);
    return post;
  }

  async getPost(id: string): Promise<Post | null> {
    return this.posts.get(id) ?? null;
  }

  async getPostByDate(runDate: ISODate, slotIndex = 0): Promise<Post | null> {
    return (
      [...this.posts.values()].find(
        (post) => post.runDate === runDate && slotOfPost(post) === slotIndex,
      ) ?? null
    );
  }

  async listPosts(filter: PostFilter = {}): Promise<Post[]> {
    return [...this.posts.values()]
      .filter((post) => (filter.statuses ? filter.statuses.includes(post.status) : true))
      .filter((post) => (filter.slotIndex === undefined ? true : slotOfPost(post) === filter.slotIndex))
      .filter((post) => (filter.from ? post.runDate >= filter.from : true))
      .filter((post) => (filter.to ? post.runDate <= filter.to : true))
      .sort((a, b) => b.runDate.localeCompare(a.runDate) || b.createdAt.localeCompare(a.createdAt))
      .slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100));
  }

  async countPosts(statuses?: PostStatus[]): Promise<number> {
    return [...this.posts.values()].filter((post) =>
      statuses ? statuses.includes(post.status) : true,
    ).length;
  }

  async updatePost(id: string, patch: PostPatch): Promise<Post> {
    const existing = this.posts.get(id);
    if (!existing) throw new AppError('NOT_FOUND', `Post ${id} not found`);
    const updated: Post = { ...existing, ...patch, updatedAt: this.now() };
    this.posts.set(id, updated);
    return updated;
  }

  async claimPostForPublish(id: string): Promise<Post | null> {
    const existing = this.posts.get(id);
    if (!existing || existing.status !== 'approved') return null;
    const updated: Post = { ...existing, status: 'publishing', updatedAt: this.now() };
    this.posts.set(id, updated);
    return updated;
  }

  async createVariants(postId: string, variants: NewPostVariant[]): Promise<PostVariant[]> {
    if (!this.posts.has(postId)) throw new AppError('NOT_FOUND', `Post ${postId} not found`);
    const now = this.now();
    const created = variants.map((variant) => {
      const row: PostVariant = {
        ...variant,
        id: crypto.randomUUID(),
        postId,
        selected: variant.variantIndex === 0,
        discardedAt: null,
        createdAt: now,
      };
      this.variants.set(row.id, row);
      return row;
    });
    return created.sort((a, b) => a.variantIndex - b.variantIndex);
  }

  async listVariants(postId: string): Promise<PostVariant[]> {
    return [...this.variants.values()]
      .filter((variant) => variant.postId === postId)
      .sort((a, b) => a.variantIndex - b.variantIndex);
  }

  async selectVariant(postId: string, variantId: string, at: string): Promise<PostVariant> {
    const target = this.variants.get(variantId);
    if (!target || target.postId !== postId) {
      throw new AppError('NOT_FOUND', `Variant ${variantId} not found for this post`);
    }
    for (const variant of this.variants.values()) {
      if (variant.postId !== postId) continue;
      if (variant.id === variantId) {
        this.variants.set(variant.id, { ...variant, selected: true, discardedAt: null });
      } else if (!variant.discardedAt) {
        this.variants.set(variant.id, { ...variant, selected: false, discardedAt: at });
      }
    }
    return this.variants.get(variantId) as PostVariant;
  }

  async pruneVariants(before: string): Promise<number> {
    let removed = 0;
    for (const [id, variant] of [...this.variants.entries()]) {
      if (variant.discardedAt && variant.discardedAt < before) {
        this.variants.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async createApproval(input: NewApproval): Promise<Approval> {
    const now = this.now();
    const approval: Approval = {
      id: crypto.randomUUID(),
      postId: input.postId,
      tokenHash: input.tokenHash,
      status: 'pending',
      action: null,
      expiresAt: input.expiresAt,
      usedAt: null,
      emailSentAt: null,
      emailMessageId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.approvals.get(id) ?? null;
  }

  async getApprovalByTokenHash(tokenHash: string): Promise<Approval | null> {
    return (
      [...this.approvals.values()].find((approval) => approval.tokenHash === tokenHash) ?? null
    );
  }

  async getActiveApprovalForPost(postId: string): Promise<Approval | null> {
    return (
      [...this.approvals.values()].find(
        (approval) => approval.postId === postId && approval.status === 'pending',
      ) ?? null
    );
  }

  async listApprovals(filter: ApprovalFilter = {}): Promise<Approval[]> {
    return [...this.approvals.values()]
      .filter((approval) => (filter.statuses ? filter.statuses.includes(approval.status) : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100);
  }

  async updateApproval(id: string, patch: ApprovalPatch): Promise<Approval> {
    const existing = this.approvals.get(id);
    if (!existing) throw new AppError('NOT_FOUND', `Approval ${id} not found`);
    const updated = { ...existing, ...patch, updatedAt: this.now() };
    this.approvals.set(id, updated);
    return updated;
  }

  async consumeApproval(tokenHash: string, action: 'approve' | 'reject'): Promise<Approval | null> {
    const existing = [...this.approvals.values()].find(
      (approval) => approval.tokenHash === tokenHash,
    );
    if (!existing) return null;
    if (existing.status !== 'pending') return null;
    if (new Date(existing.expiresAt).getTime() <= this.clock.now().getTime()) return null;
    const updated: Approval = {
      ...existing,
      status: action === 'approve' ? 'approved' : 'rejected',
      action,
      usedAt: this.now(),
      updatedAt: this.now(),
    };
    this.approvals.set(updated.id, updated);
    return updated;
  }

  async expireStaleApprovals(): Promise<{ expiredApprovals: number; expiredPosts: number }> {
    const nowMs = this.clock.now().getTime();
    let expiredApprovals = 0;
    const postIds = new Set<string>();
    for (const approval of this.approvals.values()) {
      if (approval.status === 'pending' && new Date(approval.expiresAt).getTime() <= nowMs) {
        this.approvals.set(approval.id, { ...approval, status: 'expired', updatedAt: this.now() });
        expiredApprovals += 1;
        postIds.add(approval.postId);
      }
    }
    let expiredPosts = 0;
    for (const postId of postIds) {
      const post = this.posts.get(postId);
      if (post && post.status === 'pending_approval') {
        this.posts.set(postId, { ...post, status: 'expired', updatedAt: this.now() });
        expiredPosts += 1;
      }
    }
    return { expiredApprovals, expiredPosts };
  }

  async createJob(input: NewJob): Promise<Job> {
    const existing = [...this.jobs.values()].find((job) => job.postId === input.postId);
    const now = this.now();
    if (existing) {
      const updated: Job = {
        ...existing,
        runAt: input.runAt,
        status: input.status ?? 'queued',
        lockedUntil: null,
        lastError: null,
        updatedAt: now,
      };
      this.jobs.set(updated.id, updated);
      return updated;
    }
    const job: Job = {
      id: crypto.randomUUID(),
      postId: input.postId,
      runAt: input.runAt,
      status: input.status ?? 'queued',
      attempts: 0,
      lockedUntil: null,
      lastError: null,
      externalId: null,
      postUrl: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async getJob(id: string): Promise<Job | null> {
    return this.jobs.get(id) ?? null;
  }

  async getJobByPost(postId: string): Promise<Job | null> {
    return [...this.jobs.values()].find((job) => job.postId === postId) ?? null;
  }

  async listJobs(filter: JobFilter = {}): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((job) => (filter.statuses ? filter.statuses.includes(job.status) : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100);
  }

  async claimDueJobs(limit: number): Promise<Job[]> {
    const nowMs = this.clock.now().getTime();
    const due = [...this.jobs.values()]
      .filter((job) => job.status === 'queued')
      .filter((job) => new Date(job.runAt).getTime() <= nowMs)
      .filter((job) => !job.lockedUntil || new Date(job.lockedUntil).getTime() < nowMs)
      .sort((a, b) => a.runAt.localeCompare(b.runAt))
      .slice(0, limit);
    return due.map((job) => {
      const updated: Job = {
        ...job,
        status: 'processing',
        attempts: job.attempts + 1,
        lockedUntil: new Date(nowMs + 10 * 60_000).toISOString(),
        lastError: null,
        updatedAt: this.now(),
      };
      this.jobs.set(updated.id, updated);
      return updated;
    });
  }

  async updateJob(id: string, patch: JobPatch): Promise<Job> {
    const existing = this.jobs.get(id);
    if (!existing) throw new AppError('NOT_FOUND', `Job ${id} not found`);
    const updated: Job = { ...existing, ...patch, updatedAt: this.now() };
    this.jobs.set(id, updated);
    return updated;
  }

  async recoverStuckJobs(): Promise<number> {
    const nowMs = this.clock.now().getTime();
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (
        job.status === 'processing' &&
        job.lockedUntil &&
        new Date(job.lockedUntil).getTime() < nowMs - 60_000
      ) {
        this.jobs.set(job.id, {
          ...job,
          status: 'queued',
          lockedUntil: null,
          runAt: this.now(),
          updatedAt: this.now(),
        });
        recovered += 1;
      }
    }
    for (const post of this.posts.values()) {
      if (
        post.status === 'publishing' &&
        !post.publishedAt &&
        ![...this.jobs.values()].some(
          (job) => job.postId === post.id && job.status === 'processing',
        )
      ) {
        this.posts.set(post.id, { ...post, status: 'approved', updatedAt: this.now() });
      }
    }
    return recovered;
  }

  async getIntegration(provider: IntegrationProvider): Promise<Integration | null> {
    return this.integrations.get(provider) ?? null;
  }

  async listIntegrations(): Promise<Integration[]> {
    return [...this.integrations.values()];
  }

  async upsertIntegration(
    provider: IntegrationProvider,
    patch: IntegrationPatch,
  ): Promise<Integration> {
    const existing = this.integrations.get(provider);
    const base: Integration = existing ?? {
      provider,
      status: 'disconnected',
      accountLabel: null,
      scopes: [],
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      metadata: {},
      lastCheckedAt: null,
      lastError: null,
      updatedAt: this.now(),
    };
    const updated: Integration = { ...base, ...patch, provider, updatedAt: this.now() };
    this.integrations.set(provider, updated);
    return updated;
  }

  async insertLog(entry: NewLogEntry): Promise<void> {
    this.logSequence += 1;
    this.logs.unshift({
      id: this.logSequence,
      runId: entry.runId ?? null,
      level: entry.level,
      event: entry.event,
      message: entry.message ?? null,
      context: entry.context ?? {},
      actor: entry.actor ?? 'system',
      createdAt: this.now(),
    });
    if (this.logs.length > 2000) this.logs.length = 2000;
  }

  async listLogs(filter: LogFilter = {}): Promise<LogEntry[]> {
    return this.logs
      .filter((log) => (filter.level ? log.level === filter.level : true))
      .filter((log) => (filter.event ? log.event.includes(filter.event) : true))
      .slice(0, filter.limit ?? 100);
  }

  async getSchedulerState(): Promise<SchedulerState> {
    return { ...this.scheduler };
  }

  async updateSchedulerState(patch: SchedulerPatch): Promise<SchedulerState> {
    this.scheduler = { ...this.scheduler, ...patch, updatedAt: this.now() };
    return { ...this.scheduler };
  }

  async claimGenerationSlot(date: ISODate, slotIndex: number, maxAttempts: number): Promise<boolean> {
    const key = `${date}#${slotIndex}`;
    const previous = this.generationClaims.get(key);
    if (previous && previous.status === 'succeeded') return false;
    if (previous && previous.attempts >= maxAttempts) return false;
    this.generationClaims.set(key, {
      attempts: (previous?.attempts ?? 0) + 1,
      status: 'claimed',
    });
    return true;
  }

  async finishGenerationSlot(date: ISODate, slotIndex: number, status: string): Promise<void> {
    const key = `${date}#${slotIndex}`;
    const previous = this.generationClaims.get(key);
    this.generationClaims.set(key, {
      attempts: previous?.attempts ?? 1,
      status: status === 'succeeded' ? 'succeeded' : 'failed',
    });
  }

  async claimGenerationDay(date: ISODate, maxAttempts: number): Promise<boolean> {
    const sameDay = this.scheduler.lastGenerationDate === date;
    if (sameDay && this.scheduler.lastGenerationStatus === 'succeeded') return false;
    if (sameDay && this.scheduler.generationAttempts >= maxAttempts) return false;
    this.scheduler = {
      ...this.scheduler,
      lastGenerationDate: date,
      lastGenerationAt: this.now(),
      lastGenerationStatus: 'running',
      generationAttempts: sameDay ? this.scheduler.generationAttempts + 1 : 1,
      updatedAt: this.now(),
    };
    return true;
  }

  async createWhatsAppCode(input: {
    codeHash: string;
    postId: string;
    expiresAt: string;
  }): Promise<void> {
    if (this.whatsappCodes.has(input.codeHash)) return;
    this.whatsappCodes.set(input.codeHash, {
      postId: input.postId,
      expiresAt: input.expiresAt,
      usedAt: null,
    });
  }

  async getWhatsAppCode(codeHash: string) {
    const record = this.whatsappCodes.get(codeHash);
    return record ? { ...record } : null;
  }

  async consumeWhatsAppCode(codeHash: string) {
    const record = this.whatsappCodes.get(codeHash);
    if (!record || record.usedAt) return null;
    if (new Date(record.expiresAt).getTime() <= this.clock.now().getTime()) return null;
    this.whatsappCodes.set(codeHash, { ...record, usedAt: this.now() });
    return { postId: record.postId };
  }

  async recordWhatsAppMessage(input: {
    messageId: string;
    from: string;
    receivedAt: string;
  }): Promise<boolean> {
    if (this.whatsappMessages.has(input.messageId)) return false;
    this.whatsappMessages.add(input.messageId);
    return true;
  }

  async createOAuthState(input: {
    state: string;
    provider: string;
    expiresAt: string;
    redirectAfter?: string | null;
  }): Promise<void> {
    this.oauthStates.set(input.state, {
      provider: input.provider,
      redirectAfter: input.redirectAfter ?? null,
      expiresAt: input.expiresAt,
    });
  }

  async consumeOAuthState(
    state: string,
  ): Promise<{ provider: string; redirectAfter: string | null } | null> {
    const found = this.oauthStates.get(state);
    if (!found) return null;
    this.oauthStates.delete(state);
    if (new Date(found.expiresAt).getTime() <= this.clock.now().getTime()) return null;
    return { provider: found.provider, redirectAfter: found.redirectAfter };
  }

  /** Test helper: seed a topic without going through the sheet sync. */
  seedTopic(input: Partial<Topic> & { topic: string; topicDate: ISODate }): Topic {
    const now = this.now();
    const topic: Topic = {
      id: input.id ?? crypto.randomUUID(),
      sheetRowNumber: input.sheetRowNumber ?? null,
      topicDate: input.topicDate,
      slotIndex: input.slotIndex ?? 0,
      topic: input.topic,
      contentType: input.contentType ?? 'insight',
      keyPoints: input.keyPoints ?? null,
      targetAudience: input.targetAudience ?? null,
      status: (input.status as TopicStatus) ?? 'pending',
      attempts: input.attempts ?? 0,
      lastError: input.lastError ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.topics.set(topic.id, topic);
    return topic;
  }

  /** Test helper: inspect approvals by post. */
  allApprovals(): Approval[] {
    return [...this.approvals.values()];
  }

  allJobs(): Job[] {
    return [...this.jobs.values()];
  }

  allVariants(): PostVariant[] {
    return [...this.variants.values()];
  }

  allPosts(): Post[] {
    return [...this.posts.values()];
  }

  logsSnapshot(): LogEntry[] {
    return [...this.logs];
  }

  /* ------------------------------------------------ Phase 10: API keys + webhooks */

  async createApiKey(input: ApiKeyInput): Promise<ApiKeyRecord> {
    if ([...this.apiKeys.values()].some((key) => key.keyHash === input.keyHash)) {
      throw new AppError('CONFLICT', 'This API key already exists');
    }
    const now = this.now();
    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      scopes: input.scopes,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
    };
    this.apiKeys.set(record.id, record);
    return record;
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    return [...this.apiKeys.values()].find((key) => key.keyHash === keyHash) ?? null;
  }

  async revokeApiKey(id: string, at: string): Promise<ApiKeyRecord> {
    const key = this.apiKeys.get(id);
    if (!key) throw new AppError('NOT_FOUND', `API key ${id} not found`);
    const revoked: ApiKeyRecord = { ...key, revokedAt: at };
    this.apiKeys.set(id, revoked);
    return revoked;
  }

  async touchApiKey(id: string, at: string): Promise<void> {
    const key = this.apiKeys.get(id);
    if (key) this.apiKeys.set(id, { ...key, lastUsedAt: at });
  }

  async listWebhookEndpoints(options: { activeOnly?: boolean } = {}): Promise<WebhookEndpoint[]> {
    const all = [...this.webhookEndpoints.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    return options.activeOnly ? all.filter((endpoint) => endpoint.active) : all;
  }

  async createWebhookEndpoint(input: NewWebhookEndpoint): Promise<WebhookEndpoint> {
    const now = this.now();
    const endpoint: WebhookEndpoint = {
      id: crypto.randomUUID(),
      name: input.name,
      url: input.url,
      secret: input.secret,
      events: input.events,
      active: input.active ?? true,
      failureCount: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      createdAt: now,
    };
    this.webhookEndpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  async updateWebhookEndpoint(id: string, patch: WebhookEndpointPatch): Promise<WebhookEndpoint> {
    const endpoint = this.webhookEndpoints.get(id);
    if (!endpoint) throw new AppError('NOT_FOUND', `Webhook endpoint ${id} not found`);
    const updated: WebhookEndpoint = {
      ...endpoint,
      name: patch.name ?? endpoint.name,
      url: patch.url ?? endpoint.url,
      secret: patch.secret ?? endpoint.secret,
      events: patch.events ?? endpoint.events,
      active: patch.active ?? endpoint.active,
      failureCount: patch.failureCount ?? endpoint.failureCount,
      lastSuccessAt:
        patch.lastSuccessAt !== undefined ? patch.lastSuccessAt : endpoint.lastSuccessAt,
      lastFailureAt:
        patch.lastFailureAt !== undefined ? patch.lastFailureAt : endpoint.lastFailureAt,
      lastError: patch.lastError !== undefined ? patch.lastError : endpoint.lastError,
    };
    this.webhookEndpoints.set(id, updated);
    return updated;
  }

  async deleteWebhookEndpoint(id: string): Promise<void> {
    this.webhookEndpoints.delete(id);
    for (const [deliveryId, delivery] of [...this.webhookDeliveries.entries()]) {
      if (delivery.endpointId === id) this.webhookDeliveries.delete(deliveryId);
    }
  }

  async enqueueWebhookDelivery(input: {
    endpointId: string;
    event: string;
    eventId: string;
    payload: Record<string, unknown>;
    nextAttemptAt: string;
  }): Promise<boolean> {
    const duplicate = [...this.webhookDeliveries.values()].some(
      (delivery) =>
        delivery.endpointId === input.endpointId && delivery.eventId === input.eventId,
    );
    if (duplicate) return false;
    const delivery: WebhookDelivery = {
      id: crypto.randomUUID(),
      endpointId: input.endpointId,
      event: input.event,
      eventId: input.eventId,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.nextAttemptAt,
      responseStatus: null,
      responseBody: null,
      deliveredAt: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.webhookDeliveries.set(delivery.id, delivery);
    return true;
  }

  async claimWebhookDeliveries(limit: number): Promise<WebhookDelivery[]> {
    const now = this.now();
    const due = [...this.webhookDeliveries.values()]
      .filter((delivery) => delivery.status === 'pending' && delivery.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit);
    return due.map((delivery) => {
      const claimed: WebhookDelivery = {
        ...delivery,
        status: 'delivering',
        attempts: delivery.attempts + 1,
        // When the claim was written - the database gets this from the `set_updated_at` trigger, and crash
        // recovery needs it to tell an abandoned claim from one that is in flight right now.
        updatedAt: now,
      };
      this.webhookDeliveries.set(claimed.id, claimed);
      return claimed;
    });
  }

  /**
   * The in-memory twin of `recover_webhook_deliveries` (migration 0006), and it has to fail in the same places
   * the database does: a claim is written, then the HTTP call happens, so a "crash" between the two leaves a row
   * in `delivering` that no query selects again. Five minutes is the same age the SQL uses.
   */
  async recoverWebhookDeliveries(maxAttempts = 5): Promise<number> {
    const cutoff = this.clock.now().getTime() - 5 * 60_000;
    let recovered = 0;
    for (const [id, delivery] of this.webhookDeliveries) {
      if (delivery.status !== 'delivering') continue;
      // `updatedAt` is when the claim was written - the closest thing this adapter has to the row's age.
      if (new Date(delivery.updatedAt).getTime() > cutoff) continue;
      const exhausted = delivery.attempts >= Math.max(maxAttempts, 1);
      if (!exhausted) recovered += 1;
      this.webhookDeliveries.set(id, {
        ...delivery,
        status: exhausted ? 'failed' : 'pending',
        nextAttemptAt: this.now(),
        responseBody:
          delivery.responseBody ?? 'the worker stopped before the delivery finished',
        updatedAt: this.now(),
      });
    }
    return recovered;
  }

  async updateWebhookDelivery(
    id: string,
    patch: {
      status: WebhookDelivery['status'];
      attempts: number;
      nextAttemptAt: string;
      responseStatus: number | null;
      responseBody: string | null;
      deliveredAt: string | null;
    },
  ): Promise<void> {
    const delivery = this.webhookDeliveries.get(id);
    if (!delivery) return;
    this.webhookDeliveries.set(id, { ...delivery, ...patch, updatedAt: this.now() });
  }

  async listWebhookDeliveries(
    options: { endpointId?: string; statuses?: WebhookDelivery['status'][]; limit?: number } = {},
  ): Promise<WebhookDelivery[]> {
    return [...this.webhookDeliveries.values()]
      .filter((delivery) =>
        options.endpointId ? delivery.endpointId === options.endpointId : true,
      )
      .filter((delivery) =>
        options.statuses ? options.statuses.includes(delivery.status) : true,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit ?? 100);
  }

  async savePushSubscription(input: NewPushSubscription): Promise<PushSubscription> {
    const existing = [...this.pushSubscriptions.values()].find(
      (subscription) => subscription.endpoint === input.endpoint,
    );
    const now = this.now();
    const record: PushSubscription = {
      id: existing?.id ?? crypto.randomUUID(),
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent,
      failureCount: existing?.failureCount ?? 0,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      lastError: existing?.lastError ?? null,
      createdAt: existing?.createdAt ?? now,
    };
    this.pushSubscriptions.set(record.id, record);
    return record;
  }

  async listPushSubscriptions(): Promise<PushSubscription[]> {
    return [...this.pushSubscriptions.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async deletePushSubscription(endpoint: string): Promise<void> {
    for (const [id, subscription] of [...this.pushSubscriptions.entries()]) {
      if (subscription.endpoint === endpoint) this.pushSubscriptions.delete(id);
    }
  }

  async recordPushResult(
    id: string,
    result: { ok: boolean; status?: number; error?: string; at: string },
  ): Promise<void> {
    const subscription = this.pushSubscriptions.get(id);
    if (!subscription) return;
    const gone = result.status === 404 || result.status === 410;
    if (gone) {
      this.pushSubscriptions.delete(id);
      return;
    }
    this.pushSubscriptions.set(id, {
      ...subscription,
      failureCount: result.ok ? 0 : subscription.failureCount + 1,
      lastSuccessAt: result.ok ? result.at : subscription.lastSuccessAt,
      lastError: result.ok ? null : (result.error ?? 'delivery failed'),
    });
  }
}

export function approvalStatuses(...statuses: ApprovalStatus[]): ApprovalStatus[] {
  return statuses;
}
