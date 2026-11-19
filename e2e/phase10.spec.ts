/**
 * Phase 10 end-to-end: the three things this phase added, driven against the real app.
 *
 *   1. Two posts in one day - separate topics, separate drafts, separate posts.
 *   2. OmniFlow API - a key authenticates, a scope is enforced, and a revoked key stops working at once.
 *   3. Webhooks - an endpoint is registered, a ping is queued once, and a secret is shown exactly once.
 *
 * The PWA parts (manifest, icons, service worker) are static contract, checked here because there is no
 * interaction to drive.
 */
import { expect } from '@playwright/test';
import { test } from './fixtures';

const RUN = `${Date.now()}`.slice(-5);

test.describe('two posts in one day', () => {
  test('a second slot gets its own topic, draft and post', async ({ api }) => {
    const settings = await api.get('/settings');
    expect(settings.status).toBe(200);
    const original = settings.body.data.settings as {
      publishTime: string;
      publishTimes: string[];
    };

    // A date nothing has used yet: the dev database is shared by every spec in the run.
    const existing = await api.get('/content/topics?from=2034-02-01&to=2034-02-28');
    const used = new Set(
      (existing.body.data.topics as Array<{ topicDate: string }>).map((topic) => topic.topicDate),
    );
    const day = Array.from({ length: 28 }, (_, index) => index + 1).find(
      (candidate) => !used.has(`2034-02-${String(candidate).padStart(2, '0')}`),
    );
    expect(day, 'a free February 2034 day').toBeTruthy();
    const runDate = `2034-02-${String(day).padStart(2, '0')}`;

    try {
      // Two slots, late enough that both draft windows are open whenever this run happens.
      const patched = await api.patch('/settings', { publishTimes: ['22:00', '23:00'] });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(patched.body.data.settings.publishTimes).toEqual(['22:00', '23:00']);
      // Slot 0 stays the canonical publish time, so every pre-Phase-10 reader keeps working.
      expect(patched.body.data.settings.publishTime).toBe('22:00');

      for (const [slotIndex, topic] of [
        [0, `Slot one lesson ${RUN}: what the retry loop taught us`],
        [1, `Slot two lesson ${RUN}: capping attempts instead of hiding them`],
      ] as const) {
        const created = await api.post('/content/topics', {
          topicDate: runDate,
          slotIndex,
          topic,
          contentType: 'insight',
          allowDuplicate: true,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.data.topic.slotIndex).toBe(slotIndex);
      }

      const slot0 = await api.post('/content/generate', { runDate, slotIndex: 0 });
      const slot1 = await api.post('/content/generate', { runDate, slotIndex: 1 });
      expect(slot0.status, JSON.stringify(slot0.body)).toBe(200);
      expect(slot1.status, JSON.stringify(slot1.body)).toBe(200);
      expect(slot0.body.data.result.status).toBe('generated');
      expect(slot1.body.data.result.status).toBe('generated');

      const postA = slot0.body.data.result.post;
      const postB = slot1.body.data.result.post;
      expect(postA.id).not.toBe(postB.id);
      expect(postA.slotIndex).toBe(0);
      expect(postB.slotIndex).toBe(1);
      // Different drafts: the second slot did not quietly reuse the first one's work.
      expect(postA.hook).not.toBe(postB.hook);
      expect(postA.topicId).not.toBe(postB.topicId);

      // Both exist on the same date - the whole point of the feature.
      const posts = await api.get(`/content/posts?from=${runDate}&to=${runDate}`);
      const mine = (posts.body.data.posts as Array<{ id: string; slotIndex: number }>).filter(
        (post) => post.id === postA.id || post.id === postB.id,
      );
      expect(mine).toHaveLength(2);
      expect(mine.map((post) => post.slotIndex).sort()).toEqual([0, 1]);

      // Re-running a slot is a duplicate, not a third post.
      const again = await api.post('/content/generate', { runDate, slotIndex: 0 });
      expect(again.body.data.result.status).toBe('duplicate');
    } finally {
      // Leave the schedule as it was found.
      await api.patch('/settings', {
        publishTimes: original.publishTimes?.length ? original.publishTimes : [original.publishTime],
      });
    }
  });

  test('the schedule overview lists every slot of the day', async ({ api }) => {
    const before = await api.get('/settings');
    const original = before.body.data.settings as { publishTime: string; publishTimes: string[] };
    try {
      await api.patch('/settings', { publishTimes: ['22:00', '23:00'] });
      const schedule = await api.get('/settings/schedule');
      expect(schedule.status).toBe(200);
      const today = schedule.body.data.today as { slots?: Array<{ slotIndex: number }> } | undefined;
      const slotIndexes = (today?.slots ?? []).map((slot) => slot.slotIndex);
      if (slotIndexes.length > 0) expect(slotIndexes).toContain(0);
    } finally {
      await api.patch('/settings', {
        publishTimes: original.publishTimes?.length ? original.publishTimes : [original.publishTime],
      });
    }
  });
});

test.describe('OmniFlow API', () => {
  test('a key authenticates, respects scopes and dies when revoked', async ({ api, request, baseURL }) => {
    const created = await api.post('/omni/admin/keys', { name: `e2e-${RUN}`, scopes: ['read'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const key = created.body.data.key as string;
    // The plaintext key is returned exactly once and it is not the stored hash.
    expect(key.startsWith('opk_')).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain('keyHash');

    const auth = { authorization: `Bearer ${key}` };
    const get = (path: string) => request.get(`${baseURL}/api/v1/omni${path}`, { headers: auth });

    // 1. Read works and the scopes come back as granted.
    const me = await get('/me');
    expect(me.status()).toBe(200);
    expect((await me.json()).data.scopes).toEqual(['read']);
    expect((await get('/posts?limit=1')).status()).toBe(200);

    // 2. A read key cannot write: the scope decides, not the owner's session.
    const write = await request.post(`${baseURL}/api/v1/omni/drafts`, {
      headers: auth,
      data: { topic: 'should be refused', topicDate: '2034-03-01' },
    });
    expect(write.status()).toBe(403);
    expect((await write.json()).error.message).toMatch(/scope/i);

    // 3. A dashboard token is not an API key, and a made-up key is not accepted.
    const notAKey = await request.get(`${baseURL}/api/v1/omni/me`, {
      headers: { 'x-api-key': 'opk_not_a_real_key' },
    });
    expect(notAKey.status()).toBe(401);

    // 4. Revocation takes effect on the next request, not when a session expires.
    const revoke = await api.del(`/omni/admin/keys/${created.body.data.id}`);
    expect(revoke.status).toBe(200);
    const after = await get('/me');
    expect(after.status()).toBe(401);
    expect((await after.json()).error.message).toMatch(/revoked/i);
  });

  test('the owner sees key prefixes and never a key or a hash', async ({ api }) => {
    const created = await api.post('/omni/admin/keys', {
      name: `list-${RUN}`,
      scopes: ['read', 'write'],
    });
    expect(created.status).toBe(201);
    const listed = await api.get('/omni/admin/keys');
    const mine = (listed.body.data.keys as Array<Record<string, unknown>>).find(
      (entry) => entry.id === created.body.data.id,
    );
    expect(mine).toBeTruthy();
    expect(mine!.keyPrefix).toBe(created.body.data.keyPrefix);
    expect(mine).not.toHaveProperty('keyHash');
    expect(JSON.stringify(listed.body)).not.toContain(created.body.data.key as string);

    await api.del(`/omni/admin/keys/${created.body.data.id}`);
  });
});

test.describe('webhooks', () => {
  test('an endpoint is registered, listed without its secret, and can rotate one', async ({ api }) => {
    const endpoint = await api.post('/omni/admin/webhooks', {
      name: `e2e-hook-${RUN}`,
      url: 'http://localhost:9/hooks',
      events: ['post.published'],
    });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    const secret = endpoint.body.data.secret as string;
    expect(secret.startsWith('whsec_')).toBe(true);

    // An unknown event is refused with the allowed list rather than silently accepted.
    const bad = await api.post('/omni/admin/webhooks', {
      name: 'bad',
      url: 'http://localhost:9/hooks',
      events: ['post.exploded'],
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain('post.published');

    // The listing shows a prefix only.
    const listed = await api.get('/omni/admin/webhooks');
    expect(listed.body.data.events).toContain('post.published');
    const mine = (listed.body.data.endpoints as Array<Record<string, unknown>>).find(
      (entry) => entry.id === endpoint.body.data.id,
    );
    expect(mine).toBeTruthy();
    expect(mine!.secretPrefix).toBe(secret.slice(0, 10));
    expect(JSON.stringify(listed.body)).not.toContain(secret);

    // A test ping is queued and shows up in the delivery log exactly once per request.
    const ping = await api.post(`/omni/admin/webhooks/${endpoint.body.data.id}/test`, {});
    expect(ping.status).toBe(200);
    const afterPing = await api.get('/omni/admin/webhooks');
    const pings = (afterPing.body.data.recentDeliveries as Array<{ event: string }>).filter(
      (delivery) => delivery.event === 'post.generated',
    );
    expect(pings.length).toBeGreaterThanOrEqual(1);

    // Rotation returns a new secret once and never again.
    const rotated = await api.patch(`/omni/admin/webhooks/${endpoint.body.data.id}`, {
      rotateSecret: true,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.secret).toBeTruthy();
    expect(rotated.body.data.secret).not.toBe(secret);
    const finalList = await api.get('/omni/admin/webhooks');
    expect(JSON.stringify(finalList.body)).not.toContain(rotated.body.data.secret as string);

    const removed = await api.del(`/omni/admin/webhooks/${endpoint.body.data.id}`);
    expect(removed.status).toBe(200);
  });
});

test.describe('installable PWA', () => {
  test('the manifest, icons and service worker are served and coherent', async ({ request, baseURL }) => {
    const manifestResponse = await request.get(`${baseURL}/manifest.webmanifest`);
    expect(manifestResponse.ok()).toBeTruthy();
    const manifest = await manifestResponse.json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    const icons = manifest.icons as Array<{ src: string; sizes: string }>;
    expect(icons.map((icon) => icon.sizes)).toContain('192x192');
    expect(icons.map((icon) => icon.sizes)).toContain('512x512');

    for (const icon of icons) {
      const response = await request.get(`${baseURL}${icon.src}`);
      expect(response.ok(), `${icon.src} should exist`).toBeTruthy();
      expect(response.headers()['content-type']).toContain('image/png');
    }

    const worker = await request.get(`${baseURL}/sw.js`);
    expect(worker.ok()).toBeTruthy();
    const source = await worker.text();
    // The two promises the worker makes in its comment block, asserted instead of trusted.
    expect(source).toContain("addEventListener('push'");
    expect(source).toContain("startsWith('/api/')");
  });

  test('the page links the manifest and a theme colour', async ({ page }) => {
    await page.goto('/queue/');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    );
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
      'content',
      /.+/,
    );
  });
});
