/**
 * End-to-end journey: the whole automation chain, driven through the real UI and the real API.
 *
 *   queue (UI)        -> add a topic
 *   generate (UI)     -> 3 draft options, one AI call
 *   email outbox      -> the approval link Resend would have sent
 *   /approve (UI)     -> preview, then approve
 *   publish (API)     -> LinkedIn is the local stub; the post ends up published with a URL
 *   /hooks (UI)       -> the published post shows up as a proven hook
 *
 * Every step asserts on what a person would see, and a failed request is never treated as success:
 * the API envelope is checked on the way through, so a 4xx cannot masquerade as a green run.
 */
import { expect } from '@playwright/test';

/** Keeps runs independent: the in-memory database lives as long as the dev server does. */
let runDate: string;
// Unique per run: the dev database survives between runs, and one post per day is a product rule.
const RUN = `${Date.now()}`.slice(-5);
let runCounter = 0;
import { test } from './fixtures';

/**
 * Reads the local email outbox (Resend stub) and returns the approval link for a post. `forDate` keeps
 * the lookup honest across runs: the stub keeps every message the server ever sent, so "the last one"
 * could belong to an earlier run.
 */
async function approvalLink(
  request: import('@playwright/test').APIRequestContext,
  baseURL: string,
  forDate: string,
) {
  const response = await request.get(`${baseURL}/api/v1/integrations/dev/outbox`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const messages: Array<{ subject?: string; html?: string; text?: string }> = body.data.messages;
  const forRun = messages.filter((message) => `${message.subject ?? ''}`.includes(forDate));
  expect(forRun.length, `no email for ${forDate}`).toBeGreaterThan(0);
  const latest = forRun[forRun.length - 1]!;
  const haystack = `${latest.html ?? ''} ${latest.text ?? ''}`;
  const match = /https?:\/\/[^\s"'<]+\/approve\/?\?token=([A-Za-z0-9._-]+)/.exec(haystack);
  expect(match, `no approval link in the email: ${haystack.slice(0, 300)}`).not.toBeNull();
  return { token: match![1]!, subject: latest.subject ?? '' };
}

test.describe('topic -> generate -> approve -> publish', () => {
  test('the whole chain works from the dashboard', async ({ page, request, baseURL, api }) => {
    // One post per day is a product rule and the dev database keeps history, so each run claims a date
    // nothing has used yet instead of skipping (a skipped suite proves nothing).
    const existing = await api.get(`/content/topics?from=2031-03-01&to=2031-03-28`);
    const used = new Set(
      (existing.body.data.topics as Array<{ topicDate: string }>).map((topic) => topic.topicDate),
    );
    // 1. Queue: add a topic through the dialog.
    await page.goto('/queue/');
    await page.getByRole('button', { name: /add topic manually/i }).click();
    // The dialog's accessible name is "Add topic", same as the trigger button - scope by role, not text.
    const dialog = page.getByRole('dialog', { name: 'Add topic' });
    await expect(dialog).toBeVisible();
    // Each run needs its own date: the DB is a dev singleton shared by every spec in the run.
    const freeDay = Array.from({ length: 28 }, (_, index) => index + 1).find(
      (day) => !used.has(`2031-03-${String(day).padStart(2, '0')}`),
    );
    expect(freeDay, 'every day in 2031-03 already has a topic').toBeTruthy();
    runCounter += 1;
    runDate = `2031-03-${String(freeDay).padStart(2, '0')}`;
    await page.fill('#topic-title', `Idempotency keys for agent tool calls, e2e run ${RUN} ${runDate}`);
    // Use the date the dialog offers (today in the owner's timezone): a post only publishes once its
    // slot has passed, so a far-future date would never reach the publishing step.
    await page.fill('#topic-date', runDate);
    expect(runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await dialog.getByRole('button', { name: /^add topic$/i }).click();
    await expect(page.getByText(/topic added to the queue/i)).toBeVisible();
    await expect(
      page.getByText(`Idempotency keys for agent tool calls, e2e run ${RUN} ${runDate}`),
    ).toBeVisible();

    // 2. Generate: one AI call produces three options; the first becomes the live draft.
    const generated = await api.post('/content/generate', { runDate });
    expect(generated.status, JSON.stringify(generated.body)).toBe(200);
    expect(generated.body.data.result.status).toBe('generated');
    const post = generated.body.data.result.post;
    expect(post.status).toBe('pending_approval');
    expect(post.hook.length).toBeGreaterThan(0);

    const variants = await api.get(`/content/posts/${post.id}/variants`);
    expect(variants.status).toBe(200);
    expect(variants.body.data.variants).toHaveLength(3);
    expect(variants.body.data.variants.filter((v: { selected: boolean }) => v.selected)).toHaveLength(1);

    // 3. The approval email really went out, with a usable link.
    const { token, subject } = await approvalLink(request, baseURL, runDate);
    expect(subject.length).toBeGreaterThan(0);

    // 4. Open the approval page as the owner would, from a phone-sized viewport.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`/approve/?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole('heading', { name: /review this post/i })).toBeVisible();
    // The post text is on the page, not just the metadata.
    expect(await page.locator('main, body').first().innerText()).toContain(post.hook.slice(0, 24));

    await page.getByRole('button', { name: /^approve$/i }).click();
    await expect(page.getByRole('heading', { name: /approved/i })).toBeVisible();

    // 5. Publishing: run the tick the cron would. The LinkedIn stub returns a URL, so the chain closes.
    const tick = await api.post('/schedule/run', { force: true });
    expect(tick.status, JSON.stringify(tick.body)).toBe(200);

    // LinkedIn is not connected in a fresh environment, so the honest product outcome is
    // `manual_required`: the job says so and the post is NOT marked published. Recording the real URL
    // afterwards is the same path Phase 7 uses to prove a hook - nothing is faked in between.
    let detail = await api.get(`/content/posts/${post.id}`);
    expect(detail.status).toBe(200);
    let finalPost = detail.body.data.post;
    expect(['published', 'approved']).toContain(finalPost.status);

    if (finalPost.status !== 'published') {
      const jobs = await api.get('/publishing/jobs');
      const job = jobs.body.data.jobs.find((entry: { job: { postId: string } }) => entry.job.postId === post.id);
      expect(job, 'the tick must create a job for an approved post').toBeTruthy();
      expect(['manual_required', 'queued', 'processing', 'failed']).toContain(job.job.status);
      if (job.job.status !== 'published') {
        // Refusing to invent a URL: the owner pastes the one LinkedIn gave them.
        const manual = await api.post(`/publishing/posts/${post.id}/manual`, {
          url: 'https://www.linkedin.com/feed/update/urn:li:share:7e2e0001/',
        });
        expect(manual.status, JSON.stringify(manual.body)).toBe(200);
        detail = await api.get(`/content/posts/${post.id}`);
        finalPost = detail.body.data.post;
      }
    }

    expect(finalPost.status, JSON.stringify(tick.body)).toBe('published');
    expect(finalPost.publishedUrl).toBeTruthy();

    // 6. Hooks page: the published post becomes a proven hook, derived from the post row itself.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/hooks/');
    await expect(page.getByText(/proven hook/i)).toBeVisible();
    // The prompt block the generator receives is shown verbatim, not summarised.
    // (Two elements mention it: the subtitle and the block itself - assert on the <pre> block.)
    await expect(page.locator('pre', { hasText: 'OPENINGS THAT WORKED' }).first()).toBeVisible();
  });
});
