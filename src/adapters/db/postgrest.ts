import { AppError, safeErrorMessage } from '@/src/core/errors';
import { defaultSettings } from '@/src/core/defaults';
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
  Integration,
  IntegrationProvider,
  Job,
  LogEntry,
  NewPostVariant,
  Post,
  PostStatus,
  PostVariant,
  SchedulerState,
  Settings,
  Topic,
  TopicStatus,
  ApprovalStatus,
  JobStatus,
} from '@/src/core/types';
import type {
  ApprovalFilter,
  ApprovalPatch,
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
  WhatsAppCodeRecord,
} from '@/src/core/ports';

type Row = Record<string, unknown>;
type FilterValue = string | number | boolean | null;

export interface PostgrestConfig {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Minimal PostgREST client: fetch-only, so it runs unchanged on Workers and Node. */
export class PostgrestClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly http: typeof fetch;

  constructor(config: PostgrestConfig) {
    this.baseUrl = `${config.url.replace(/\/+$/, '')}/rest/v1`;
    this.key = config.serviceRoleKey;
    this.http = config.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra,
    };
  }

  private async request(
    path: string,
    init: RequestInit & { expectEmpty?: boolean; retryable?: boolean } = {},
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const attempts = init.retryable ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.http(url, {
          ...init,
          headers: this.headers((init.headers as Record<string, string>) ?? {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) {
          if (init.expectEmpty || response.status === 204) return null;
          const text = await response.text();
          if (!text) return null;
          return JSON.parse(text) as unknown;
        }
        const body = await response.text();
        const parsed = safeParse(body);
        const code = typeof parsed?.code === 'string' ? parsed.code : undefined;
        const message =
          (typeof parsed?.message === 'string' && parsed.message) ||
          `PostgREST request failed with status ${response.status}`;
        if (code === '23505') {
          throw new AppError('CONFLICT', `Duplicate record: ${message}`, { details: { path } });
        }
        const error = new AppError(
          response.status === 401 || response.status === 403 ? 'DATABASE_ERROR' : 'DATABASE_ERROR',
          `Database error: ${message}`,
          { details: { status: response.status, path, code }, retryable: response.status >= 500 },
        );
        if (response.status >= 500 && attempt < attempts) {
          lastError = error;
          await sleep(400 * attempt);
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof AppError) throw error;
        lastError = error;
        if (attempt < attempts) {
          await sleep(400 * attempt);
          continue;
        }
        throw new AppError('DATABASE_ERROR', `Database unreachable: ${safeErrorMessage(error)}`, {
          retryable: true,
          cause: error,
        });
      }
    }
    throw new AppError(
      'DATABASE_ERROR',
      `Database request failed: ${safeErrorMessage(lastError)}`,
      {
        retryable: true,
        cause: lastError,
      },
    );
  }

  async select<T extends Row>(
    table: string,
    params: Record<string, string>,
    retryable = true,
  ): Promise<T[]> {
    const query = new URLSearchParams(params).toString();
    const result = await this.request(`/${table}?${query}`, { method: 'GET', retryable });
    return (result as T[]) ?? [];
  }

  async count(table: string, params: Record<string, string>): Promise<number> {
    const query = new URLSearchParams(params).toString();
    const response = await this.http(`${this.baseUrl}/${table}?${query}`, {
      method: 'HEAD',
      headers: this.headers({ Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AppError('DATABASE_ERROR', `Count failed with status ${response.status}`);
    }
    const contentRange = response.headers.get('content-range');
    const total = contentRange?.split('/')[1];
    return total ? Number(total) : 0;
  }

  async insert<T extends Row>(
    table: string,
    rows: Row[] | Row,
    options: { onConflict?: string; ignoreDuplicates?: boolean } = {},
  ): Promise<T[]> {
    const params = new URLSearchParams();
    if (options.onConflict) params.set('on_conflict', options.onConflict);
    params.set('select', '*');
    // PostgREST needs an explicit resolution strategy when on_conflict is used,
    // otherwise a second write for the same key fails with a unique violation.
    const prefer = options.ignoreDuplicates
      ? 'resolution=ignore-duplicates,return=representation'
      : options.onConflict
        ? 'resolution=merge-duplicates,return=representation'
        : 'return=representation';
    const result = await this.request(`/${table}?${params.toString()}`, {
      method: 'POST',
      body: JSON.stringify(rows),
      headers: { Prefer: prefer },
    });
    return (result as T[]) ?? [];
  }

  async update<T extends Row>(
    table: string,
    filters: Record<string, string>,
    patch: Row,
  ): Promise<T[]> {
    const params = new URLSearchParams({ ...filters, select: '*' });
    const result = await this.request(`/${table}?${params.toString()}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      headers: { Prefer: 'return=representation' },
    });
    return (result as T[]) ?? [];
  }

  async remove(table: string, filters: Record<string, string>): Promise<void> {
    const params = new URLSearchParams(filters).toString();
    await this.request(`/${table}?${params}`, { method: 'DELETE', expectEmpty: true });
  }

  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.request(`/rpc/${fn}`, {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return result as T;
  }
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ts(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredTs(value: unknown): string {
  return ts(value) ?? new Date(0).toISOString();
}

function dateOnly(value: unknown): string {
  return String(value).slice(0, 10);
}

function shortTime(value: unknown): string {
  return String(value ?? '').slice(0, 5);
}

function arrays(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

interface SettingsRow extends Row {
  owner_timezone: string;
  generation_time: string;
  publish_time: string;
  publish_days: number[];
  respect_publish_time: boolean;
  auto_publish_on_approval: boolean;
  approval_ttl_hours: number;
  ai_provider: string;
  ai_model: string;
  brand_voice: string;
  writing_instructions: string;
  hashtag_min: number;
  hashtag_max: number;
  max_post_chars: number;
  email_notifications: boolean;
  publish_times?: string[] | null;
  posts_per_day?: number | null;
  updated_at: string;
}

export class PostgrestDatabase implements Database {
  constructor(private readonly client: PostgrestClient) {}

  static create(config: PostgrestConfig): PostgrestDatabase {
    return new PostgrestDatabase(new PostgrestClient(config));
  }

  private async selectOne<T extends Row>(
    table: string,
    params: Record<string, string>,
  ): Promise<T | null> {
    const rows = await this.client.select<T>(table, { ...params, limit: '1' });
    return rows[0] ?? null;
  }

  async getSettings(): Promise<Settings> {
    const row = await this.selectOne<SettingsRow>('app_settings', { select: '*', id: 'eq.true' });
    if (!row) return defaultSettings();
    return mapSettings(row);
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const body: Row = {};
    if (patch.ownerTimezone !== undefined) body.owner_timezone = patch.ownerTimezone;
    if (patch.generationTime !== undefined) body.generation_time = patch.generationTime;
    if (patch.publishTime !== undefined) body.publish_time = patch.publishTime;
    if (patch.publishDays !== undefined) body.publish_days = patch.publishDays;
    if (patch.respectPublishTime !== undefined)
      body.respect_publish_time = patch.respectPublishTime;
    if (patch.autoPublishOnApproval !== undefined)
      body.auto_publish_on_approval = patch.autoPublishOnApproval;
    if (patch.approvalTtlHours !== undefined) body.approval_ttl_hours = patch.approvalTtlHours;
    if (patch.aiProvider !== undefined) body.ai_provider = patch.aiProvider;
    if (patch.aiModel !== undefined) body.ai_model = patch.aiModel;
    if (patch.brandVoice !== undefined) body.brand_voice = patch.brandVoice;
    if (patch.writingInstructions !== undefined)
      body.writing_instructions = patch.writingInstructions;
    if (patch.hashtagMin !== undefined) body.hashtag_min = patch.hashtagMin;
    if (patch.hashtagMax !== undefined) body.hashtag_max = patch.hashtagMax;
    if (patch.maxPostChars !== undefined) body.max_post_chars = patch.maxPostChars;
    if (patch.publishTimes !== undefined) {
      body.publish_times = patch.publishTimes;
      // publish_time keeps its meaning as slot 0, so an older reader still sees the first slot.
      if (patch.publishTimes[0]) body.publish_time = patch.publishTimes[0];
    }
    if (patch.emailNotifications !== undefined) body.email_notifications = patch.emailNotifications;
    if (Object.keys(body).length === 0) return this.getSettings();
    const rows = await this.client.update<SettingsRow>('app_settings', { id: 'eq.true' }, body);
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'Settings row missing - run the migrations.');
    return mapSettings(row);
  }

  async listTopics(filter: TopicFilter = {}): Promise<Topic[]> {
    const params: Record<string, string> = {
      select: '*',
      order: 'topic_date.desc,created_at.asc',
      limit: String(filter.limit ?? 200),
    };
    if (filter.statuses?.length) params.status = `in.(${filter.statuses.join(',')})`;
    if (filter.slotIndex !== undefined) params.slot_index = `eq.${filter.slotIndex}`;
    // A single column can only carry one operator per query, so a two-sided range has to become an
    // `and(...)` group - assigning `gte` then `lte` to the same key silently dropped the lower bound.
    if (filter.from && filter.to) {
      params.and = `(topic_date.gte.${filter.from},topic_date.lte.${filter.to})`;
    } else if (filter.from) {
      params.topic_date = `gte.${filter.from}`;
    } else if (filter.to) {
      params.topic_date = `lte.${filter.to}`;
    }
    const rows = await this.client.select<Row>('content_topics', params);
    return rows.map(mapTopic);
  }

  async getTopic(id: string): Promise<Topic | null> {
    const row = await this.selectOne<Row>('content_topics', { select: '*', id: `eq.${id}` });
    return row ? mapTopic(row) : null;
  }

  async createTopic(input: Parameters<Database['createTopic']>[0]): Promise<Topic> {
    const rows = await this.client.insert<Row>('content_topics', {
      sheet_row_number: input.sheetRowNumber,
      topic_date: input.topicDate,
      // Phase 10: the slot this topic feeds. Omitting it is not "slot 0" - PostgREST leaves the column out of
      // the INSERT and PostgreSQL fills the `default 0`, so the row is created, the request answers 201, and
      // the slot the caller asked for is silently gone. `npm run e2e` saw exactly that: a second slot asked
      // for 1 and read back 0. Always send it.
      slot_index: input.slotIndex ?? 0,
      topic: input.topic,
      content_type: input.contentType,
      key_points: input.keyPoints,
      target_audience: input.targetAudience,
    });
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'Topic insert returned no row');
    const created = mapTopic(row);
    // Fail loudly instead of answering 201 with the wrong slot.
    //
    // The database fills `default 0` for a column the INSERT does not name, so a dropped `slot_index` looks
    // like a successful creation and only the *second* publish time of a day notices - as
    // `Expected: 1, Received: 0` on a topic that was just created. Comparing what came back with what was
    // asked for turns that silent drift into one sentence naming the column.
    const wanted = input.slotIndex ?? 0;
    if (created.slotIndex !== wanted) {
      throw new AppError(
        'DATABASE_ERROR',
        `Topic was stored in slot ${created.slotIndex} but slot ${wanted} was requested - ` +
          'content_topics.slot_index was not written (check that the INSERT names the column and that ' +
          'supabase/migrations/0005_slots_and_api.sql has been applied).',
        { details: { wanted, stored: created.slotIndex, topicId: created.id } },
      );
    }
    return created;
  }

  async updateTopic(id: string, patch: TopicPatch): Promise<Topic> {
    const body: Row = {};
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.lastError !== undefined) body.last_error = patch.lastError;
    if (patch.sheetRowNumber !== undefined) body.sheet_row_number = patch.sheetRowNumber;
    if (patch.topicDate !== undefined) body.topic_date = patch.topicDate;
    const rows = await this.client.update<Row>('content_topics', { id: `eq.${id}` }, body);
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', `Topic ${id} not found`);
    return mapTopic(row);
  }

  async upsertTopics(
    topics: Parameters<Database['upsertTopics']>[0],
  ): Promise<{ inserted: number; skipped: number }> {
    if (topics.length === 0) return { inserted: 0, skipped: 0 };
    const payload = topics.map((topic) => ({
      sheet_row_number: topic.sheetRowNumber,
      topic_date: topic.topicDate,
      // Same trap as `createTopic`: an omitted column is not "slot 0", it is the column default. A sheet row
      // that names slot 2 would be synced into slot 0, and the day would silently lose a publish time.
      slot_index: topic.slotIndex ?? 0,
      topic: topic.topic,
      content_type: topic.contentType,
      key_points: topic.keyPoints,
      target_audience: topic.targetAudience,
    }));
    const inserted = await this.client.insert<Row>('content_topics', payload, {
      onConflict: 'topic_date,topic',
      ignoreDuplicates: true,
    });
    return { inserted: inserted.length, skipped: payload.length - inserted.length };
  }

  async claimDailyTopic(
    topicDate: string,
    maxAttempts: number,
    slotIndex = 0,
  ): Promise<Topic | null> {
    const rows = await this.client.rpc<Row[]>('claim_daily_topic', {
      p_date: topicDate,
      p_max_attempts: maxAttempts,
      p_slot: slotIndex,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? mapTopic(row) : null;
  }

  async createPost(input: Parameters<Database['createPost']>[0]): Promise<Post> {
    const rows = await this.client.insert<Row>('generated_posts', {
      topic_id: input.topicId,
      run_date: input.runDate,
      slot_index: input.slotIndex ?? 0,
      hook: input.hook,
      body: input.body,
      hashtags: input.hashtags,
      full_text: input.fullText,
      char_count: input.charCount,
      provider: input.provider,
      model: input.model,
      status: input.status,
      source: input.source,
    });
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'Post insert returned no row');
    return mapPost(row);
  }

  async getPost(id: string): Promise<Post | null> {
    const row = await this.selectOne<Row>('generated_posts', { select: '*', id: `eq.${id}` });
    return row ? mapPost(row) : null;
  }

  async getPostByDate(runDate: string, slotIndex = 0): Promise<Post | null> {
    const row = await this.selectOne<Row>('generated_posts', {
      select: '*',
      run_date: `eq.${runDate}`,
      slot_index: `eq.${slotIndex}`,
    });
    return row ? mapPost(row) : null;
  }

  async claimGenerationSlot(date: string, slotIndex: number, maxAttempts: number): Promise<boolean> {
    const claimed = await this.client.rpc<boolean>('claim_generation_slot', {
      p_date: date,
      p_slot: slotIndex,
      p_max_attempts: maxAttempts,
    });
    return claimed === true;
  }

  async finishGenerationSlot(date: string, slotIndex: number, status: string): Promise<void> {
    await this.client.rpc('finish_generation_slot', {
      p_date: date,
      p_slot: slotIndex,
      p_status: status,
    });
  }

  async listPosts(filter: PostFilter = {}): Promise<Post[]> {
    const params: Record<string, string> = {
      select: '*',
      order: 'run_date.desc',
      limit: String(filter.limit ?? 100),
    };
    if (filter.offset) params.offset = String(filter.offset);
    if (filter.statuses?.length) params.status = `in.(${filter.statuses.join(',')})`;
    if (filter.slotIndex !== undefined) params.slot_index = `eq.${filter.slotIndex}`;
    if (filter.from && filter.to) {
      params.and = `(run_date.gte.${filter.from},run_date.lte.${filter.to})`;
    } else if (filter.from) {
      params.run_date = `gte.${filter.from}`;
    } else if (filter.to) {
      params.run_date = `lte.${filter.to}`;
    }
    const rows = await this.client.select<Row>('generated_posts', params);
    return rows.map(mapPost);
  }

  async countPosts(statuses?: PostStatus[]): Promise<number> {
    const params: Record<string, string> = { select: 'id' };
    if (statuses?.length) params.status = `in.(${statuses.join(',')})`;
    return this.client.count('generated_posts', params);
  }

  async updatePost(id: string, patch: PostPatch): Promise<Post> {
    const body: Row = {};
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.hook !== undefined) body.hook = patch.hook;
    if (patch.body !== undefined) body.body = patch.body;
    if (patch.hashtags !== undefined) body.hashtags = patch.hashtags;
    if (patch.fullText !== undefined) body.full_text = patch.fullText;
    if (patch.charCount !== undefined) body.char_count = patch.charCount;
    if (patch.errorMessage !== undefined) body.error_message = patch.errorMessage;
    if (patch.externalId !== undefined) body.external_id = patch.externalId;
    if (patch.publishedUrl !== undefined) body.published_url = patch.publishedUrl;
    if (patch.publishedAt !== undefined) body.published_at = patch.publishedAt;
    if (patch.editedByOwner !== undefined) body.edited_by_owner = patch.editedByOwner;
    if (patch.provider !== undefined) body.provider = patch.provider;
    if (patch.model !== undefined) body.model = patch.model;
    if (patch.source !== undefined) body.source = patch.source;
    const rows = await this.client.update<Row>('generated_posts', { id: `eq.${id}` }, body);
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', `Post ${id} not found`);
    return mapPost(row);
  }

  async claimPostForPublish(id: string): Promise<Post | null> {
    const rows = await this.client.rpc<Row[]>('claim_post_for_publish', { p_post_id: id });
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? mapPost(row) : null;
  }

  async createVariants(postId: string, variants: NewPostVariant[]): Promise<PostVariant[]> {
    if (variants.length === 0) return [];
    const rows = await this.client.insert<Row>(
      'post_variants',
      variants.map((variant) => ({
        post_id: postId,
        variant_index: variant.variantIndex,
        angle: variant.angle,
        hook: variant.hook,
        body: variant.body,
        hashtags: variant.hashtags,
        full_text: variant.fullText,
        char_count: variant.charCount,
        selected: variant.variantIndex === 0,
      })),
      { onConflict: 'post_id,variant_index' },
    );
    return rows.map(mapVariant).sort((a, b) => a.variantIndex - b.variantIndex);
  }

  async listVariants(postId: string): Promise<PostVariant[]> {
    const rows = await this.client.select<Row>('post_variants', {
      select: '*',
      post_id: `eq.${postId}`,
      order: 'variant_index.asc',
    });
    return rows.map(mapVariant);
  }

  async selectVariant(postId: string, variantId: string, at: string): Promise<PostVariant> {
    // Discard the others first: a half-applied selection would leave two "selected" rows.
    await this.client.update<Row>(
      'post_variants',
      { post_id: `eq.${postId}`, id: `neq.${variantId}`, selected: 'eq.true' },
      { selected: false, discarded_at: at },
    );
    const rows = await this.client.update<Row>(
      'post_variants',
      { post_id: `eq.${postId}`, id: `eq.${variantId}` },
      { selected: true, discarded_at: null },
    );
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', `Variant ${variantId} not found for this post`);
    return mapVariant(row);
  }

  async pruneVariants(before: string): Promise<number> {
    const rows = await this.client.select<Row>('post_variants', {
      select: 'id',
      discarded_at: `lt.${before}`,
      limit: '200',
    });
    if (rows.length === 0) return 0;
    await this.client.remove('post_variants', { discarded_at: `lt.${before}` });
    return rows.length;
  }

  async createApproval(input: NewApproval): Promise<Approval> {
    const rows = await this.client.insert<Row>('approval_requests', {
      post_id: input.postId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
    });
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'Approval insert returned no row');
    return mapApproval(row);
  }

  async getApproval(id: string): Promise<Approval | null> {
    const row = await this.selectOne<Row>('approval_requests', { select: '*', id: `eq.${id}` });
    return row ? mapApproval(row) : null;
  }

  async getApprovalByTokenHash(tokenHash: string): Promise<Approval | null> {
    const row = await this.selectOne<Row>('approval_requests', {
      select: '*',
      token_hash: `eq.${tokenHash}`,
    });
    return row ? mapApproval(row) : null;
  }

  async getActiveApprovalForPost(postId: string): Promise<Approval | null> {
    const row = await this.selectOne<Row>('approval_requests', {
      select: '*',
      post_id: `eq.${postId}`,
      status: 'eq.pending',
      order: 'created_at.desc',
    });
    return row ? mapApproval(row) : null;
  }

  async listApprovals(filter: ApprovalFilter = {}): Promise<Approval[]> {
    const params: Record<string, string> = {
      select: '*',
      order: 'created_at.desc',
      limit: String(filter.limit ?? 100),
    };
    if (filter.statuses?.length) params.status = `in.(${filter.statuses.join(',')})`;
    const rows = await this.client.select<Row>('approval_requests', params);
    return rows.map(mapApproval);
  }

  async updateApproval(id: string, patch: ApprovalPatch): Promise<Approval> {
    const body: Row = {};
    if (patch.emailSentAt !== undefined) body.email_sent_at = patch.emailSentAt;
    if (patch.emailMessageId !== undefined) body.email_message_id = patch.emailMessageId;
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.usedAt !== undefined) body.used_at = patch.usedAt;
    if (patch.action !== undefined) body.action = patch.action;
    const rows = await this.client.update<Row>('approval_requests', { id: `eq.${id}` }, body);
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', `Approval ${id} not found`);
    return mapApproval(row);
  }

  async consumeApproval(tokenHash: string, action: 'approve' | 'reject'): Promise<Approval | null> {
    const rows = await this.client.rpc<Row[]>('consume_approval', {
      p_token_hash: tokenHash,
      p_action: action,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? mapApproval(row) : null;
  }

  async expireStaleApprovals(): Promise<{ expiredApprovals: number; expiredPosts: number }> {
    const rows = await this.client.rpc<Array<{ expired_approvals: number; expired_posts: number }>>(
      'expire_stale_approvals',
      {},
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return { expiredApprovals: row?.expired_approvals ?? 0, expiredPosts: row?.expired_posts ?? 0 };
  }

  async createJob(input: NewJob): Promise<Job> {
    const rows = await this.client.insert<Row>(
      'publishing_jobs',
      { post_id: input.postId, run_at: input.runAt, status: input.status ?? 'queued' },
      { onConflict: 'post_id' },
    );
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'Job insert returned no row');
    return mapJob(row);
  }

  async getJob(id: string): Promise<Job | null> {
    const row = await this.selectOne<Row>('publishing_jobs', { select: '*', id: `eq.${id}` });
    return row ? mapJob(row) : null;
  }

  async getJobByPost(postId: string): Promise<Job | null> {
    const row = await this.selectOne<Row>('publishing_jobs', {
      select: '*',
      post_id: `eq.${postId}`,
    });
    return row ? mapJob(row) : null;
  }

  async listJobs(filter: JobFilter = {}): Promise<Job[]> {
    const params: Record<string, string> = {
      select: '*',
      order: 'created_at.desc',
      limit: String(filter.limit ?? 100),
    };
    if (filter.statuses?.length) params.status = `in.(${filter.statuses.join(',')})`;
    const rows = await this.client.select<Row>('publishing_jobs', params);
    return rows.map(mapJob);
  }

  async claimDueJobs(limit: number): Promise<Job[]> {
    const rows = await this.client.rpc<Row[]>('claim_publishing_jobs', { p_limit: limit });
    return (Array.isArray(rows) ? rows : []).map(mapJob);
  }

  async updateJob(id: string, patch: JobPatch): Promise<Job> {
    const body: Row = {};
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.runAt !== undefined) body.run_at = patch.runAt;
    if (patch.lockedUntil !== undefined) body.locked_until = patch.lockedUntil;
    if (patch.lastError !== undefined) body.last_error = patch.lastError;
    if (patch.externalId !== undefined) body.external_id = patch.externalId;
    if (patch.postUrl !== undefined) body.post_url = patch.postUrl;
    if (patch.publishedAt !== undefined) body.published_at = patch.publishedAt;
    const rows = await this.client.update<Row>('publishing_jobs', { id: `eq.${id}` }, body);
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', `Job ${id} not found`);
    return mapJob(row);
  }

  async recoverStuckJobs(): Promise<number> {
    const result = await this.client.rpc<number>('recover_stuck_jobs', {});
    return typeof result === 'number' ? result : 0;
  }

  /**
   * `recover_webhook_deliveries` (migration 0006). A delivery claimed by a worker that then died stays
   * `delivering` for ever: nothing selects it and nothing reports it. The function moves claims older than five
   * minutes back to `pending`, and closes the ones that have used every attempt.
   */
  async recoverWebhookDeliveries(maxAttempts = 5): Promise<number> {
    const result = await this.client.rpc<number>('recover_webhook_deliveries', {
      p_max_attempts: maxAttempts,
    });
    return typeof result === 'number' ? result : 0;
  }

  async getIntegration(provider: IntegrationProvider): Promise<Integration | null> {
    const row = await this.selectOne<Row>('integrations', {
      select: '*',
      provider: `eq.${provider}`,
    });
    return row ? mapIntegration(row) : null;
  }

  async listIntegrations(): Promise<Integration[]> {
    const rows = await this.client.select<Row>('integrations', {
      select: '*',
      order: 'provider.asc',
    });
    return rows.map(mapIntegration);
  }

  async upsertIntegration(
    provider: IntegrationProvider,
    patch: IntegrationPatch,
  ): Promise<Integration> {
    const body: Row = { provider };
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.accountLabel !== undefined) body.account_label = patch.accountLabel;
    if (patch.scopes !== undefined) body.scopes = patch.scopes;
    if (patch.accessTokenEnc !== undefined) body.access_token_enc = patch.accessTokenEnc;
    if (patch.refreshTokenEnc !== undefined) body.refresh_token_enc = patch.refreshTokenEnc;
    if (patch.tokenExpiresAt !== undefined) body.token_expires_at = patch.tokenExpiresAt;
    if (patch.metadata !== undefined) body.metadata = patch.metadata;
    if (patch.lastCheckedAt !== undefined) body.last_checked_at = patch.lastCheckedAt;
    if (patch.lastError !== undefined) body.last_error = patch.lastError;
    const rows = await this.client.insert<Row>('integrations', body, { onConflict: 'provider' });
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'Integration upsert returned no row');
    return mapIntegration(row);
  }

  async insertLog(entry: NewLogEntry): Promise<void> {
    await this.client.insert('execution_logs', {
      run_id: entry.runId ?? null,
      level: entry.level,
      event: entry.event,
      message: entry.message ?? null,
      context: entry.context ?? {},
      actor: entry.actor ?? 'system',
    });
  }

  async listLogs(filter: LogFilter = {}): Promise<LogEntry[]> {
    const params: Record<string, string> = {
      select: '*',
      order: 'created_at.desc',
      limit: String(filter.limit ?? 100),
    };
    if (filter.level) params.level = `eq.${filter.level}`;
    if (filter.event) params.event = `ilike.*${filter.event}*`;
    const rows = await this.client.select<Row>('execution_logs', params);
    return rows.map(mapLog);
  }

  async getSchedulerState(): Promise<SchedulerState> {
    const row = await this.selectOne<Row>('scheduler_state', { select: '*', id: 'eq.true' });
    if (!row) {
      return {
        lastGenerationDate: null,
        lastGenerationAt: null,
        lastGenerationStatus: null,
        generationAttempts: 0,
        lastPublishSweepAt: null,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      lastGenerationDate: row.last_generation_date ? dateOnly(row.last_generation_date) : null,
      lastGenerationAt: ts(row.last_generation_at),
      lastGenerationStatus:
        (row.last_generation_status as SchedulerState['lastGenerationStatus']) ?? null,
      generationAttempts: Number(row.generation_attempts ?? 0),
      lastPublishSweepAt: ts(row.last_publish_sweep_at),
      updatedAt: requiredTs(row.updated_at),
    };
  }

  async updateSchedulerState(patch: SchedulerPatch): Promise<SchedulerState> {
    const body: Row = {};
    if (patch.lastGenerationDate !== undefined)
      body.last_generation_date = patch.lastGenerationDate;
    if (patch.lastGenerationAt !== undefined) body.last_generation_at = patch.lastGenerationAt;
    if (patch.lastGenerationStatus !== undefined)
      body.last_generation_status = patch.lastGenerationStatus;
    if (patch.generationAttempts !== undefined) body.generation_attempts = patch.generationAttempts;
    if (patch.lastPublishSweepAt !== undefined)
      body.last_publish_sweep_at = patch.lastPublishSweepAt;
    if (Object.keys(body).length > 0) {
      await this.client.update('scheduler_state', { id: 'eq.true' }, body);
    }
    return this.getSchedulerState();
  }

  async claimGenerationDay(date: string, maxAttempts: number): Promise<boolean> {
    const result = await this.client.rpc<boolean | null>('claim_generation_day', {
      p_date: date,
      p_max_attempts: maxAttempts,
    });
    return result === true;
  }

  async createWhatsAppCode(input: {
    codeHash: string;
    postId: string;
    expiresAt: string;
  }): Promise<void> {
    await this.client.insert(
      'whatsapp_approval_codes',
      { code_hash: input.codeHash, post_id: input.postId, expires_at: input.expiresAt },
      { onConflict: 'code_hash', ignoreDuplicates: true },
    );
  }

  async getWhatsAppCode(codeHash: string): Promise<WhatsAppCodeRecord | null> {
    const rows = await this.client.select<Row>('whatsapp_approval_codes', {
      select: 'post_id,expires_at,used_at',
      code_hash: `eq.${codeHash}`,
      limit: '1',
    });
    const row = rows[0];
    if (!row) return null;
    return {
      postId: String(row.post_id),
      expiresAt: requiredTs(row.expires_at),
      usedAt: ts(row.used_at),
    };
  }

  /** Atomic single use: only an unused, unexpired code is claimed. */
  async consumeWhatsAppCode(codeHash: string): Promise<{ postId: string } | null> {
    const now = new Date().toISOString();
    const rows = await this.client.update<Row>(
      'whatsapp_approval_codes',
      { code_hash: `eq.${codeHash}`, used_at: 'is.null', expires_at: `gt.${now}` },
      { used_at: now },
    );
    const row = rows[0];
    return row ? { postId: String(row.post_id) } : null;
  }

  async recordWhatsAppMessage(input: {
    messageId: string;
    from: string;
    receivedAt: string;
  }): Promise<boolean> {
    const rows = await this.client.insert<Row>(
      'whatsapp_messages',
      {
        message_id: input.messageId,
        from_number: input.from,
        received_at: input.receivedAt,
      },
      { onConflict: 'message_id', ignoreDuplicates: true },
    );
    return rows.length > 0;
  }

  async createOAuthState(input: {
    state: string;
    provider: string;
    expiresAt: string;
    redirectAfter?: string | null;
  }): Promise<void> {
    await this.client.insert('oauth_states', {
      state: input.state,
      provider: input.provider,
      expires_at: input.expiresAt,
      redirect_after: input.redirectAfter ?? null,
    });
  }

  async consumeOAuthState(
    state: string,
  ): Promise<{ provider: string; redirectAfter: string | null } | null> {
    const rows = await this.client.select<Row>('oauth_states', {
      select: '*',
      state: `eq.${state}`,
    });
    const row = rows[0];
    if (!row) return null;
    // OAuth states are single-use: remove before validating so a replay cannot succeed.
    await this.client.remove('oauth_states', { state: `eq.${state}` });
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
    return {
      provider: String(row.provider),
      redirectAfter: row.redirect_after ? String(row.redirect_after) : null,
    };
  }

  /* ------------------------------------------------ Phase 10: API keys + webhooks */

  async createApiKey(input: ApiKeyInput): Promise<ApiKeyRecord> {
    const rows = await this.client.insert<Row>('api_keys', {
      name: input.name,
      key_hash: input.keyHash,
      key_prefix: input.keyPrefix,
      scopes: input.scopes,
    });
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'API key insert returned no row');
    return mapApiKey(row);
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const rows = await this.client.select<Row>('api_keys', {
      select: '*',
      order: 'created_at.desc',
    });
    return rows.map(mapApiKey);
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const row = await this.selectOne<Row>('api_keys', { select: '*', key_hash: `eq.${keyHash}` });
    return row ? mapApiKey(row) : null;
  }

  async revokeApiKey(id: string, at: string): Promise<ApiKeyRecord> {
    const rows = await this.client.update<Row>('api_keys', { id: `eq.${id}` }, { revoked_at: at });
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', `API key ${id} not found`);
    return mapApiKey(row);
  }

  async touchApiKey(id: string, at: string): Promise<void> {
    await this.client.update('api_keys', { id: `eq.${id}` }, { last_used_at: at });
  }

  async listWebhookEndpoints(
    options: { activeOnly?: boolean } = {},
  ): Promise<WebhookEndpoint[]> {
    const params: Record<string, string> = { select: '*', order: 'created_at.asc' };
    if (options.activeOnly) params.active = 'is.true';
    const rows = await this.client.select<Row>('webhook_endpoints', params);
    return rows.map(mapWebhookEndpoint);
  }

  async createWebhookEndpoint(input: NewWebhookEndpoint): Promise<WebhookEndpoint> {
    const rows = await this.client.insert<Row>('webhook_endpoints', {
      name: input.name,
      url: input.url,
      secret: input.secret,
      events: input.events,
      active: input.active ?? true,
    });
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'Webhook insert returned no row');
    return mapWebhookEndpoint(row);
  }

  async updateWebhookEndpoint(
    id: string,
    patch: WebhookEndpointPatch,
  ): Promise<WebhookEndpoint> {
    const body: Row = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.url !== undefined) body.url = patch.url;
    if (patch.secret !== undefined) body.secret = patch.secret;
    if (patch.events !== undefined) body.events = patch.events;
    if (patch.active !== undefined) body.active = patch.active;
    if (patch.failureCount !== undefined) body.failure_count = patch.failureCount;
    if (patch.lastSuccessAt !== undefined) body.last_success_at = patch.lastSuccessAt;
    if (patch.lastFailureAt !== undefined) body.last_failure_at = patch.lastFailureAt;
    if (patch.lastError !== undefined) body.last_error = patch.lastError;
    const rows = await this.client.update<Row>('webhook_endpoints', { id: `eq.${id}` }, body);
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', `Webhook endpoint ${id} not found`);
    return mapWebhookEndpoint(row);
  }

  async deleteWebhookEndpoint(id: string): Promise<void> {
    await this.client.remove('webhook_endpoints', { id: `eq.${id}` });
  }

  async enqueueWebhookDelivery(input: {
    endpointId: string;
    event: string;
    eventId: string;
    payload: Record<string, unknown>;
    nextAttemptAt: string;
  }): Promise<boolean> {
    // `resolution=ignore-duplicates` turns the unique (endpoint, event_id) index into "already queued",
    // so a retried tick cannot double-deliver an event.
    const rows = await this.client.insert<Row>(
      'webhook_deliveries',
      {
        endpoint_id: input.endpointId,
        event: input.event,
        event_id: input.eventId,
        payload: input.payload,
        next_attempt_at: input.nextAttemptAt,
      },
      { onConflict: 'endpoint_id,event_id', ignoreDuplicates: true },
    );
    return rows.length > 0;
  }

  async claimWebhookDeliveries(limit: number): Promise<WebhookDelivery[]> {
    const rows = await this.client.rpc<Row[]>('claim_webhook_deliveries', { p_limit: limit });
    return (Array.isArray(rows) ? rows : []).map(mapWebhookDelivery);
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
    await this.client.update(
      'webhook_deliveries',
      { id: `eq.${id}` },
      {
        status: patch.status,
        attempts: patch.attempts,
        next_attempt_at: patch.nextAttemptAt,
        response_status: patch.responseStatus,
        response_body: patch.responseBody,
        delivered_at: patch.deliveredAt,
      },
    );
  }

  async listWebhookDeliveries(
    options: { endpointId?: string; statuses?: WebhookDelivery['status'][]; limit?: number } = {},
  ): Promise<WebhookDelivery[]> {
    const params: Record<string, string> = {
      select: '*',
      order: 'created_at.desc',
      limit: String(options.limit ?? 50),
    };
    if (options.endpointId) params.endpoint_id = `eq.${options.endpointId}`;
    if (options.statuses?.length) params.status = `in.(${options.statuses.join(',')})`;
    const rows = await this.client.select<Row>('webhook_deliveries', params);
    return rows.map(mapWebhookDelivery);
  }

  async savePushSubscription(input: NewPushSubscription): Promise<PushSubscription> {
    // Endpoint is unique: a re-subscribe from the same browser updates the row instead of piling up.
    const rows = await this.client.insert<Row>(
      'push_subscriptions',
      {
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        user_agent: input.userAgent,
      },
      { onConflict: 'endpoint', ignoreDuplicates: false },
    );
    const row = rows[0];
    if (!row) throw new AppError('DATABASE_ERROR', 'Push subscription insert returned no row');
    return mapPushSubscription(row);
  }

  async listPushSubscriptions(): Promise<PushSubscription[]> {
    const rows = await this.client.select<Row>('push_subscriptions', {
      select: '*',
      order: 'created_at.asc',
    });
    return rows.map(mapPushSubscription);
  }

  async deletePushSubscription(endpoint: string): Promise<void> {
    await this.client.remove('push_subscriptions', { endpoint: `eq.${endpoint}` });
  }

  async recordPushResult(
    id: string,
    result: { ok: boolean; status?: number; error?: string; at: string },
  ): Promise<void> {
    if (result.status === 404 || result.status === 410) {
      // The browser dropped the subscription: keep the table clean instead of retrying forever.
      await this.client.remove('push_subscriptions', { id: `eq.${id}` });
      return;
    }
    const current = await this.selectOne<Row>('push_subscriptions', { select: '*', id: `eq.${id}` });
    const failures = Number(current?.failure_count ?? 0);
    await this.client.update(
      'push_subscriptions',
      { id: `eq.${id}` },
      result.ok
        ? { failure_count: 0, last_success_at: result.at, last_error: null }
        : { failure_count: failures + 1, last_error: result.error ?? 'delivery failed' },
    );
  }
}

function mapApiKey(row: Row): ApiKeyRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    keyHash: String(row.key_hash),
    keyPrefix: String(row.key_prefix ?? ''),
    scopes: arrays(row.scopes) as ApiKeyRecord['scopes'],
    lastUsedAt: ts(row.last_used_at),
    revokedAt: ts(row.revoked_at),
    createdAt: requiredTs(row.created_at),
  };
}

function mapWebhookEndpoint(row: Row): WebhookEndpoint {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    url: String(row.url ?? ''),
    secret: String(row.secret ?? ''),
    events: arrays(row.events),
    active: Boolean(row.active),
    failureCount: Number(row.failure_count ?? 0),
    lastSuccessAt: ts(row.last_success_at),
    lastFailureAt: ts(row.last_failure_at),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: requiredTs(row.created_at),
  };
}

function mapWebhookDelivery(row: Row): WebhookDelivery {
  return {
    id: String(row.id),
    endpointId: String(row.endpoint_id),
    event: String(row.event),
    eventId: String(row.event_id),
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: String(row.status ?? 'pending') as WebhookDelivery['status'],
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: requiredTs(row.next_attempt_at),
    responseStatus:
      row.response_status === null || row.response_status === undefined
        ? null
        : Number(row.response_status),
    responseBody: row.response_body ? String(row.response_body) : null,
    deliveredAt: ts(row.delivered_at),
    createdAt: requiredTs(row.created_at),
    // `updated_at` drives crash recovery: it is how old a claim is. Falls back to `created_at` for a row written
    // before the column existed, so the value is never undefined.
    updatedAt: row.updated_at ? requiredTs(row.updated_at) : requiredTs(row.created_at),
  };
}

function mapPushSubscription(row: Row): PushSubscription {
  return {
    id: String(row.id),
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    userAgent: row.user_agent ? String(row.user_agent) : null,
    failureCount: Number(row.failure_count ?? 0),
    lastSuccessAt: ts(row.last_success_at),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: requiredTs(row.created_at),
  };
}

function mapSettings(row: SettingsRow): Settings {
  return {
    ownerTimezone: row.owner_timezone,
    generationTime: shortTime(row.generation_time),
    publishTime: shortTime(row.publish_time),
    publishDays: arrays(row.publish_days)
      .map(Number)
      .filter((day) => day >= 1 && day <= 7),
    respectPublishTime: Boolean(row.respect_publish_time),
    autoPublishOnApproval: Boolean(row.auto_publish_on_approval),
    approvalTtlHours: Number(row.approval_ttl_hours ?? 48),
    aiProvider: row.ai_provider ?? 'gemini',
    aiModel: row.ai_model ?? 'gemini-2.5-flash',
    brandVoice: row.brand_voice ?? defaultSettings().brandVoice,
    writingInstructions: row.writing_instructions ?? defaultSettings().writingInstructions,
    hashtagMin: Number(row.hashtag_min ?? 3),
    hashtagMax: Number(row.hashtag_max ?? 5),
    maxPostChars: Number(row.max_post_chars ?? 2800),
    emailNotifications: Boolean(row.email_notifications),
    // Phase 10: falls back to the single publish_time for rows written before the migration.
    publishTimes: (() => {
      const list = arrays(row.publish_times as string[] | null)
        .map((time) => shortTime(String(time)))
        .filter(Boolean);
      return list.length > 0 ? list : [shortTime(row.publish_time)];
    })(),
    updatedAt: requiredTs(row.updated_at),
  };
}

function mapTopic(row: Row): Topic {
  return {
    id: String(row.id),
    sheetRowNumber:
      row.sheet_row_number === null || row.sheet_row_number === undefined
        ? null
        : Number(row.sheet_row_number),
    topicDate: dateOnly(row.topic_date),
    slotIndex: Number(row.slot_index ?? 0),
    topic: String(row.topic),
    contentType: String(row.content_type ?? 'insight'),
    keyPoints: row.key_points ? String(row.key_points) : null,
    targetAudience: row.target_audience ? String(row.target_audience) : null,
    status: String(row.status) as TopicStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: requiredTs(row.created_at),
    updatedAt: requiredTs(row.updated_at),
  };
}

function mapVariant(row: Row): PostVariant {
  return {
    id: String(row.id),
    postId: String(row.post_id),
    variantIndex: Number(row.variant_index ?? 0),
    angle: String(row.angle ?? ''),
    hook: String(row.hook ?? ''),
    body: String(row.body ?? ''),
    hashtags: arrays(row.hashtags),
    fullText: String(row.full_text ?? ''),
    charCount: Number(row.char_count ?? 0),
    selected: Boolean(row.selected),
    discardedAt: ts(row.discarded_at),
    createdAt: requiredTs(row.created_at),
  };
}

function mapPost(row: Row): Post {
  return {
    id: String(row.id),
    topicId: row.topic_id ? String(row.topic_id) : null,
    runDate: dateOnly(row.run_date),
    slotIndex: Number(row.slot_index ?? 0),
    hook: String(row.hook ?? ''),
    body: String(row.body ?? ''),
    hashtags: arrays(row.hashtags),
    fullText: String(row.full_text ?? ''),
    charCount: Number(row.char_count ?? 0),
    provider: String(row.provider ?? ''),
    model: String(row.model ?? ''),
    status: String(row.status) as Post['status'],
    source: String(row.source ?? 'ai'),
    editedByOwner: Boolean(row.edited_by_owner),
    errorMessage: row.error_message ? String(row.error_message) : null,
    externalId: row.external_id ? String(row.external_id) : null,
    publishedUrl: row.published_url ? String(row.published_url) : null,
    publishedAt: ts(row.published_at),
    createdAt: requiredTs(row.created_at),
    updatedAt: requiredTs(row.updated_at),
  };
}

function mapApproval(row: Row): Approval {
  return {
    id: String(row.id),
    postId: String(row.post_id),
    tokenHash: String(row.token_hash),
    status: String(row.status) as ApprovalStatus,
    action: row.action ? String(row.action) : null,
    expiresAt: requiredTs(row.expires_at),
    usedAt: ts(row.used_at),
    emailSentAt: ts(row.email_sent_at),
    emailMessageId: row.email_message_id ? String(row.email_message_id) : null,
    createdAt: requiredTs(row.created_at),
    updatedAt: requiredTs(row.updated_at),
  };
}

function mapJob(row: Row): Job {
  return {
    id: String(row.id),
    postId: String(row.post_id),
    runAt: requiredTs(row.run_at),
    status: String(row.status) as JobStatus,
    attempts: Number(row.attempts ?? 0),
    lockedUntil: ts(row.locked_until),
    lastError: row.last_error ? String(row.last_error) : null,
    externalId: row.external_id ? String(row.external_id) : null,
    postUrl: row.post_url ? String(row.post_url) : null,
    publishedAt: ts(row.published_at),
    createdAt: requiredTs(row.created_at),
    updatedAt: requiredTs(row.updated_at),
  };
}

function mapIntegration(row: Row): Integration {
  return {
    provider: String(row.provider) as IntegrationProvider,
    status: String(row.status ?? 'disconnected') as Integration['status'],
    accountLabel: row.account_label ? String(row.account_label) : null,
    scopes: arrays(row.scopes),
    accessTokenEnc: row.access_token_enc ? String(row.access_token_enc) : null,
    refreshTokenEnc: row.refresh_token_enc ? String(row.refresh_token_enc) : null,
    tokenExpiresAt: ts(row.token_expires_at),
    metadata:
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : {},
    lastCheckedAt: ts(row.last_checked_at),
    lastError: row.last_error ? String(row.last_error) : null,
    updatedAt: requiredTs(row.updated_at),
  };
}

function mapLog(row: Row): LogEntry {
  return {
    id: Number(row.id),
    runId: row.run_id ? String(row.run_id) : null,
    level: String(row.level ?? 'info') as LogEntry['level'],
    event: String(row.event),
    message: row.message ? String(row.message) : null,
    context:
      row.context && typeof row.context === 'object'
        ? (row.context as Record<string, unknown>)
        : {},
    actor: String(row.actor ?? 'system'),
    createdAt: requiredTs(row.created_at),
  };
}

// Filters type re-export keeps the filter unions close to the PostgREST implementation.
export type { FilterValue };
