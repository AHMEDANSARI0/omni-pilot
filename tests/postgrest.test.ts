import { describe, expect, it } from 'vitest';
import { PostgrestDatabase } from '@/src/adapters/db/postgrest';
import { PostgrestClient } from '@/src/adapters/db/postgrest';
import { AppError } from '@/src/core/errors';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (captured: Captured) => {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function fakeFetch(handler: Handler, calls: Captured[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(captured);
    const result = handler(captured);
    const bodyText = result.body === undefined ? '' : JSON.stringify(result.body);
    const nullBodyStatus = result.status === 204 || result.status === 304;
    return new Response(nullBodyStatus ? null : bodyText, {
      status: result.status,
      headers: result.headers,
    });
  }) as unknown as typeof fetch;
}

function database(handler: Handler) {
  const calls: Captured[] = [];
  const client = new PostgrestClient({
    url: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-key',
    fetchImpl: fakeFetch(handler, calls),
  });
  return { db: new PostgrestDatabase(client), calls };
}

const SETTINGS_ROW = {
  owner_timezone: 'Asia/Karachi',
  generation_time: '08:00:00',
  publish_time: '09:30:00',
  publish_days: [1, 2, 3, 4, 5],
  respect_publish_time: true,
  auto_publish_on_approval: true,
  approval_ttl_hours: 48,
  ai_provider: 'gemini',
  ai_model: 'gemini-2.5-flash',
  brand_voice: 'voice',
  writing_instructions: 'rules',
  hashtag_min: 3,
  hashtag_max: 5,
  max_post_chars: 2800,
  email_notifications: true,
  updated_at: '2026-11-16T03:00:00+00:00',
};

describe('PostgREST adapter (production database path)', () => {
  it('sends the service-role credentials and reads settings with type mapping', async () => {
    const { db, calls } = database(() => ({ status: 200, body: [SETTINGS_ROW] }));
    const settings = await db.getSettings();

    expect(calls[0]?.url).toContain('/rest/v1/app_settings?');
    expect(calls[0]?.headers.apikey).toBe('service-role-key');
    expect(calls[0]?.headers.Authorization).toBe('Bearer service-role-key');
    expect(settings.ownerTimezone).toBe('Asia/Karachi');
    expect(settings.generationTime).toBe('08:00');
    expect(settings.publishTime).toBe('09:30');
    expect(settings.publishDays).toEqual([1, 2, 3, 4, 5]);
    expect(settings.updatedAt).toBe('2026-11-16T03:00:00.000Z');
  });

  it('upserts topics with ignore-duplicates so a re-sync is safe', async () => {
    const { db, calls } = database(() => ({ status: 201, body: [{ id: 't1' }] }));
    const result = await db.upsertTopics([
      {
        sheetRowNumber: 2,
        topicDate: '2026-11-16',
        topic: 'Idempotency keys',
        contentType: 'insight',
        keyPoints: null,
        targetAudience: null,
      },
      {
        sheetRowNumber: 3,
        topicDate: '2026-11-17',
        topic: 'Retries',
        contentType: 'insight',
        keyPoints: null,
        targetAudience: null,
      },
    ]);

    expect(calls[0]?.url).toContain('on_conflict=topic_date%2Ctopic');
    expect(calls[0]?.headers.Prefer).toBe('resolution=ignore-duplicates,return=representation');
    expect(result).toEqual({ inserted: 1, skipped: 1 });
  });

  it('stores WhatsApp codes hashed and claims them atomically once', async () => {
    let claims = 0;
    const { db, calls } = database((captured) => {
      // The conditional PATCH only matches the row once; a second claim updates nothing.
      if (captured.method === 'PATCH') {
        claims += 1;
        return { status: 200, body: claims === 1 ? [{ post_id: 'p1' }] : [] };
      }
      return { status: 201, body: [{ post_id: 'p1' }] };
    });

    await db.createWhatsAppCode({
      codeHash: 'hash-1',
      postId: 'p1',
      expiresAt: '2026-11-16T15:00:00.000Z',
    });
    expect(calls[0]?.url).toContain('/rest/v1/whatsapp_approval_codes?on_conflict=code_hash');
    expect(calls[0]?.headers.Prefer).toBe('resolution=ignore-duplicates,return=representation');
    expect(calls[0]?.body).toEqual({
      code_hash: 'hash-1',
      post_id: 'p1',
      expires_at: '2026-11-16T15:00:00.000Z',
    });

    const claimed = await db.consumeWhatsAppCode('hash-1');
    expect(claimed).toEqual({ postId: 'p1' });
    const url = calls[1]?.url ?? '';
    expect(url).toContain('code_hash=eq.hash-1');
    expect(url).toContain('used_at=is.null');

    const second = await db.consumeWhatsAppCode('hash-1');
    expect(second).toBeNull();

    const fresh = await db.recordWhatsAppMessage({
      messageId: 'wamid.1',
      from: '923001234567',
      receivedAt: '2026-11-16T05:10:00.000Z',
    });
    expect(fresh).toBe(true);
    expect(calls.at(-1)?.url).toContain('/rest/v1/whatsapp_messages?on_conflict=message_id');
  });

  it('treats a replayed WhatsApp message id as already processed', async () => {
    const { db } = database(() => ({ status: 201, body: [] }));
    const fresh = await db.recordWhatsAppMessage({
      messageId: 'wamid.dup',
      from: '923001234567',
      receivedAt: '2026-11-16T05:10:00.000Z',
    });
    expect(fresh).toBe(false);
  });

  it('upserts integrations with merge-duplicates (token refresh must not 409)', async () => {
    const { db, calls } = database(() => ({ status: 201, body: [{ provider: 'google_sheets' }] }));
    await db.upsertIntegration('google_sheets', { status: 'connected', accessTokenEnc: 'enc' });

    expect(calls[0]?.url).toContain('on_conflict=provider');
    expect(calls[0]?.headers.Prefer).toContain('resolution=merge-duplicates');
    expect(calls[0]?.body).toMatchObject({ provider: 'google_sheets', status: 'connected' });
  });

  it('upserts publishing jobs with merge-duplicates on post_id', async () => {
    const { db, calls } = database(() => ({
      status: 201,
      body: [
        {
          id: 'j1',
          post_id: 'p1',
          run_at: '2026-11-16T05:00:00+00:00',
          status: 'queued',
          attempts: 0,
          locked_until: null,
          last_error: null,
          external_id: null,
          post_url: null,
          published_at: null,
          created_at: '2026-11-16T05:00:00+00:00',
          updated_at: '2026-11-16T05:00:00+00:00',
        },
      ],
    }));
    const job = await db.createJob({ postId: 'p1', runAt: '2026-11-16T05:00:00.000Z' });
    expect(calls[0]?.url).toContain('on_conflict=post_id');
    expect(calls[0]?.headers.Prefer).toContain('merge-duplicates');
    expect(job.status).toBe('queued');
  });

  it('maps a unique violation to a CONFLICT AppError', async () => {
    const { db } = database(() => ({
      status: 409,
      body: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "generated_posts_run_date_key"',
      },
    }));
    await expect(
      db.createPost({
        topicId: null,
        runDate: '2026-11-16',
        hook: 'h',
        body: 'b',
        hashtags: ['#A'],
        fullText: 'h\n\nb\n\n#A',
        charCount: 10,
        provider: 'p',
        model: 'm',
        status: 'pending_approval',
        source: 'ai',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('retries a 500 once and then succeeds', async () => {
    let attempt = 0;
    const { db } = database(() => {
      attempt += 1;
      return attempt === 1 ? { status: 500, body: { message: 'boom' } } : { status: 200, body: [] };
    });
    await expect(db.listPosts({ limit: 5 })).resolves.toEqual([]);
    expect(attempt).toBe(2);
  });

  it('parses exact counts from the content-range header', async () => {
    const calls: Captured[] = [];
    const client = new PostgrestClient({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'k',
      fetchImpl: fakeFetch(
        () => ({ status: 200, body: undefined, headers: { 'content-range': '0-0/42' } }),
        calls,
      ),
    });
    const db = new PostgrestDatabase(client);
    await expect(db.countPosts(['published'])).resolves.toBe(42);
    expect(calls[0]?.method).toBe('HEAD');
    expect(calls[0]?.url).toContain('status=in.%28published%29');
  });

  it('calls the atomic RPCs with the right arguments', async () => {
    const { db, calls } = database((captured) => {
      if (captured.url.includes('claim_generation_day')) return { status: 200, body: true };
      if (captured.url.includes('consume_approval')) return { status: 200, body: [] };
      if (captured.url.includes('claim_daily_topic')) {
        return {
          status: 200,
          body: [
            {
              id: 't1',
              sheet_row_number: 2,
              topic_date: '2026-11-16',
              topic: 'Topic',
              content_type: 'insight',
              key_points: null,
              target_audience: null,
              status: 'claimed',
              attempts: 1,
              last_error: null,
              created_at: '2026-11-16T03:00:00+00:00',
              updated_at: '2026-11-16T03:00:00+00:00',
            },
          ],
        };
      }
      if (captured.url.includes('expire_stale_approvals')) {
        return { status: 200, body: [{ expired_approvals: 1, expired_posts: 1 }] };
      }
      return { status: 200, body: null };
    });

    const topic = await db.claimDailyTopic('2026-11-16', 3);
    expect(topic?.status).toBe('claimed');
    expect(calls[0]?.url).toContain('/rpc/claim_daily_topic');
    expect(calls[0]?.body).toEqual({ p_date: '2026-11-16', p_max_attempts: 3 });

    await expect(db.claimGenerationDay('2026-11-16', 3)).resolves.toBe(true);
    await expect(db.consumeApproval('hash', 'approve')).resolves.toBeNull();
    await expect(db.expireStaleApprovals()).resolves.toEqual({
      expiredApprovals: 1,
      expiredPosts: 1,
    });
    await expect(db.claimPostForPublish('missing')).resolves.toBeNull();
  });

  it('consumes OAuth state exactly once by deleting the row', async () => {
    const rows = [
      {
        state: 'abc',
        provider: 'linkedin',
        redirect_after: '/settings/',
        expires_at: '2099-01-01T00:00:00Z',
      },
    ];
    const { db, calls } = database((captured) => {
      if (captured.method === 'GET') return { status: 200, body: rows.splice(0) };
      if (captured.method === 'DELETE') return { status: 204 };
      return { status: 204 };
    });

    const state = await db.consumeOAuthState('abc');
    expect(state).toEqual({ provider: 'linkedin', redirectAfter: '/settings/' });
    expect(calls[1]?.method).toBe('DELETE');

    // Replay: no row left, so the second read returns nothing.
    const replay = await db.consumeOAuthState('abc');
    expect(replay).toBeNull();
  });

  it('throws DATABASE_ERROR with a safe message when the database is unreachable', async () => {
    const client = new PostgrestClient({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'k',
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const db = new PostgrestDatabase(client);
    const error = await db.getSettings().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('DATABASE_ERROR');
  });
});
