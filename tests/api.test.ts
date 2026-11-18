import { describe, expect, it } from 'vitest';
import { createApp } from '@/src/worker/app';
import { createHarness, extractTokenFromEmail, testConfig, type Harness } from './helpers';

const BASE = 'http://automation.test';

function appFor(harness: Harness, services = harness.services) {
  return createApp({ serviceFactory: async () => services });
}

async function call(
  app: ReturnType<typeof createApp>,
  harness: Harness,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await app.fetch(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string>),
      },
    }),
    harness.env as Record<string, string>,
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe('API surface', () => {
  it('exposes a public health check', async () => {
    const harness = createHarness();
    const app = appFor(harness);
    const { status, body } = await call(app, harness, '/api/v1/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      status: 'ok',
      servicesMode: 'local',
      database: { ok: true },
    });
  });

  it('requires authentication unless the dev bypass is enabled', async () => {
    const harness = createHarness();
    const services = {
      ...harness.services,
      config: testConfig({ ALLOW_DEV_BYPASS: '', DEV_OWNER_TOKEN: 'local-dev-owner-token' }),
    };
    const app = appFor(harness, services);

    const unauthorized = await call(app, harness, '/api/v1/overview');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error.code).toBe('UNAUTHORIZED');

    const withDevToken = await call(app, harness, '/api/v1/overview', {
      headers: { 'x-dev-owner-token': 'local-dev-owner-token' },
    });
    expect(withDevToken.status).toBe(200);
    expect(withDevToken.body.data.stats.total).toBe(0);

    const wrongToken = await call(app, harness, '/api/v1/overview', {
      headers: { 'x-dev-owner-token': 'nope' },
    });
    expect(wrongToken.status).toBe(401);
  });

  it('runs the full generate -> approve -> publish flow through the API', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    const app = appFor(harness);

    const generated = await call(app, harness, '/api/v1/content/generate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(generated.status).toBe(200);
    expect(generated.body.data.result.status).toBe('generated');
    const postId = generated.body.data.result.post.id;

    const approvals = await call(app, harness, '/api/v1/approvals');
    expect(approvals.body.data.approvals).toHaveLength(1);
    expect(approvals.body.data.approvals[0].post.id).toBe(postId);

    const token = extractTokenFromEmail(
      harness.email.sent.find((message) => message.html.includes('/approve/?token='))!.html,
    );
    const preview = await call(app, harness, `/api/v1/public/approvals/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data.state).toBe('actionable');

    const decision = await call(app, harness, `/api/v1/public/approvals/${token}/decision`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(decision.status).toBe(200);
    expect(decision.body.data.postStatus).toBe('published');
    expect(decision.body.data.publish.status).toBe('published');

    const replay = await call(app, harness, `/api/v1/public/approvals/${token}/decision`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(replay.status).toBe(409);

    const overview = await call(app, harness, '/api/v1/overview');
    expect(overview.body.data.stats.published).toBe(1);
    expect(harness.linkedin.publishCalls).toHaveLength(1);

    const history = await call(app, harness, '/api/v1/publishing/history');
    expect(history.body.data.history).toHaveLength(1);
    expect(history.body.data.history[0].publishedUrl).toContain('linkedin.com');
  });

  it('validates settings input with helpful errors', async () => {
    const harness = createHarness();
    const app = appFor(harness);

    const bad = await call(app, harness, '/api/v1/settings', {
      method: 'PATCH',
      body: JSON.stringify({ publishTime: '25:99', ownerTimezone: 'Mars/Olympus' }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(bad.body.error.details)).toContain('publishTime');

    const ok = await call(app, harness, '/api/v1/settings', {
      method: 'PATCH',
      body: JSON.stringify({ publishTime: '10:15', publishDays: [1, 3, 5] }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.settings.publishTime).toBe('10:15');
    expect(ok.body.data.settings.publishDays).toEqual([1, 3, 5]);
  });

  it('protects the cron endpoint with the shared secret', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const app = appFor(harness);

    const denied = await call(app, harness, '/api/v1/schedule/cron', { method: 'POST' });
    expect(denied.status).toBe(401);

    const allowed = await call(app, harness, '/api/v1/schedule/cron', {
      method: 'POST',
      headers: { 'x-cron-secret': 'test-cron-secret-with-enough-length' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.generation.result.status).toBe('generated');
  });

  it('supports manual publishing fallback through the API', async () => {
    const harness = createHarness({ now: '2026-11-16T05:00:00Z' });
    const app = appFor(harness);
    await call(app, harness, '/api/v1/content/generate', { method: 'POST', body: '{}' });

    // Simulate an expired/absent LinkedIn authorization: publishing must not fake success.
    harness.linkedin.connected = false;
    harness.linkedin.needsReauth = true;

    const post = harness.db.allPosts()[0]!;
    const decision = await call(app, harness, `/api/v1/approvals/${post.id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(decision.status).toBe(200);
    expect(decision.body.data.publish.status).toBe('manual_required');
    expect(decision.body.data.post.status).toBe('approved');
    const manual = await call(app, harness, `/api/v1/publishing/posts/${post.id}/manual`, {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.linkedin.com/feed/update/urn:li:share:42/' }),
    });
    expect(manual.status).toBe(200);
    expect(manual.body.data.post.publishedUrl).toContain('urn:li:share:42');
  });

  it('filters logs and returns recent activity', async () => {
    const harness = createHarness();
    const app = appFor(harness);
    await call(app, harness, '/api/v1/content/generate', { method: 'POST', body: '{}' });

    const all = await call(app, harness, '/api/v1/logs?limit=50');
    expect(all.body.data.logs.length).toBeGreaterThan(2);

    const errors = await call(app, harness, '/api/v1/logs?level=error');
    expect(errors.body.data.logs.every((log: { level: string }) => log.level === 'error')).toBe(
      true,
    );
  });

  it('returns structured 404s for unknown API routes', async () => {
    const harness = createHarness();
    const app = appFor(harness);
    const { status, body } = await call(app, harness, '/api/v1/nope');
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed JSON bodies without crashing', async () => {
    const harness = createHarness();
    const app = appFor(harness);
    const response = await app.fetch(
      new Request(`${BASE}/api/v1/content/topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      }),
      harness.env as Record<string, string>,
    );
    expect([400, 422]).toContain(response.status);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('creates manual topics and rejects duplicates', async () => {
    const harness = createHarness();
    const app = appFor(harness);
    const payload = {
      topicDate: '2026-11-20',
      topic: 'Designing retries for webhook consumers',
      contentType: 'how-to',
    };
    const first = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);

    const duplicate = await call(app, harness, '/api/v1/content/topics', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    expect(duplicate.status).toBe(409);
  });
});
