/**
 * The two guards that protect the owner from himself, driven through the UI.
 *
 *   1. The duplicate guard: a near-repeat is refused with the earlier topic named, and it cannot be
 *      added twice for the same date (Phase 8 honesty fix: "nothing added", not a fake success).
 *   2. The approval link: single use, and a token that was already used cannot approve twice.
 *
 * These are the failures that would quietly publish the wrong thing, so they are tested every run
 * rather than trusted to unit tests alone.
 */
import { expect } from '@playwright/test';
import { test } from './fixtures';

// Unique per run: the in-memory database is a single dev instance that survives between runs, so a
// fixed date would fail the *second* time this suite runs on the same server.
const RUN = `${Date.now()}`.slice(-5);
let counter = 0;

/**
 * Clears the queue for a date so a spec starts from a known state. The API has no delete endpoint (the
 * product has no reason to lose history), so this skips the date-dependent assertions when a previous
 * run already used it - the failure would be leftover data, not a defect.
 */
async function dateHasTopics(api: { get: (p: string) => Promise<{ body: any }> }, date: string) {
  const response = await api.get(`/content/topics?from=${date}&to=${date}`);
  return (response.body?.data?.topics ?? []).length > 0;
}

/**
 * Finds a day in `month` that no earlier run used. The dev database keeps history, and one post per day
 * is a product rule, so a fixed date makes the suite fail the second time it runs on the same server.
 */
async function pickFreeDate(
  api: { get: (p: string) => Promise<{ body: any }> },
  month: string,
  startDay = 1,
) {
  for (let day = startDay; day <= 28; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    if (!(await dateHasTopics(api, date))) return date;
  }
  throw new Error(`no free date left in ${month}: every day already has a topic`);
}

test.describe('duplicate guard', () => {
  test('a near-repeat is named, and "Add anyway" never claims a second row', async ({ page, evidence }) => {
    void evidence;
    const date = `2032-05-${String(10 + counter++).padStart(2, '0')}`;
    const original = `Why every agent tool call needs an idempotency key, run ${date}`;

    await page.goto('/queue/');
    const dialog = page.getByRole('dialog', { name: 'Add topic' });

    // 1. First entry goes in normally.
    await page.getByRole('button', { name: /add topic manually/i }).click();
    await page.fill('#topic-title', original);
    await page.fill('#topic-date', date);
    await dialog.getByRole('button', { name: /^add topic$/i }).click();
    await expect(page.getByText(/topic added to the queue/i)).toBeVisible();

    // 2. A reworded repeat is refused, and the dialog says which earlier topic it collided with -
    //    a toast would be missed, so the warning lives inside the dialog.
    await page.getByRole('button', { name: /add topic manually/i }).click();
    await page.fill('#topic-title', original.replace('Why every', 'Why each'));
    await page.fill('#topic-date', date);
    await dialog.getByRole('button', { name: /^add topic$/i }).click();
    await expect(page.getByText(/looks like a repeat/i)).toBeVisible();
    await expect(dialog.getByText(/\d+% the same idea/i)).toBeVisible();

    // 3. "Add anyway" is for a *reworded* repeat on another date; the exact same text on the same
    //    date cannot become a second row (UNIQUE (topic_date, topic)). Put the original text back so
    //    that is the case being tested, then confirm the UI says "nothing added" and the list is
    //    unchanged - the Phase 7 leftover Phase 8 closed.
    // Typing clears the warning on purpose (new text deserves a new check), so re-run the check.
    await page.fill('#topic-title', original);
    await dialog.getByRole('button', { name: /^add topic$/i }).click();
    await expect(dialog.getByText(/looks like a repeat/i)).toBeVisible();
    const rowsBefore = await page.locator('main p.break-words').count();
    await dialog.getByRole('button', { name: /^add anyway$/i }).click();
    // The toast is short-lived and the dialog closes on success; assert on the toast text rendered
    // anywhere in the ui region, and on the list itself (the durable evidence).
    await expect(page.getByText(/nothing added/i)).toBeVisible({ timeout: 5000 });
    await expect(dialog).toBeHidden();
    await expect(page.locator('main p.break-words')).toHaveCount(rowsBefore);
  });

  test('the same wording on another date is added for real', async ({ page, api }) => {
    // The guard is about *recent work*, not about one date: the same text on another day is a real new
    // topic, and "Add anyway" must actually add it (a refusal here would be the guard over-reaching).
    // Dates are chosen free per run, because the dev database keeps what earlier runs added.
    const startDay = 1 + (Number(RUN) % 20);
    const firstDate = await pickFreeDate(api, '2032-08', startDay);
    const secondDate = await pickFreeDate(api, '2032-08', startDay + 1);
    const text = `Queue takeover ${RUN}: what we changed after the retry loop misfired`;

    await page.goto('/queue/');
    const dialog = page.getByRole('dialog', { name: 'Add topic' });

    await page.getByRole('button', { name: /add topic manually/i }).click();
    await page.fill('#topic-title', text);
    await page.fill('#topic-date', firstDate);
    await dialog.getByRole('button', { name: /^add topic$/i }).click();
    await expect(page.getByText(/topic added to the queue/i)).toBeVisible();

    await page.getByRole('button', { name: /add topic manually/i }).click();
    await page.fill('#topic-title', text);
    await page.fill('#topic-date', secondDate);
    await dialog.getByRole('button', { name: /^add topic$/i }).click();
    // Same words = certain warning, which is the state this test needs to override.
    await expect(dialog.getByText(/looks like a repeat/i)).toBeVisible();
    await dialog.getByRole('button', { name: /^add anyway$/i }).click();

    await expect(dialog).toBeHidden();

    // "Added for real" is a fact about the data, not about how many rows happen to be on screen: both
    // dates must exist now. (Counting rows here would also count whatever an earlier run left behind.)
    const stored = await api.get(`/content/topics?from=${firstDate}&to=${secondDate}`);
    const dates = (stored.body.data.topics as Array<{ topicDate: string }>).map((t) => t.topicDate);
    expect(dates).toContain(firstDate);
    expect(dates).toContain(secondDate);
  });

});

test.describe('approval link', () => {
  test('a decided link cannot be used twice and shows the real state', async ({ api, page }) => {
    const runDate = await pickFreeDate(api, '2033-01');
    // Setup may override the duplicate guard: this spec is about the approval link, and the text is
    // unique per run anyway (`RUN`), so a re-run against the same server is never a skip.
    const topic = await api.post('/content/topics', {
      topicDate: runDate,
      topic: `Single use approval link ${RUN}, ${runDate}`,
      contentType: 'insight',
      allowDuplicate: true,
    });
    expect(topic.status, JSON.stringify(topic.body)).toBe(201);
    const generated = await api.post('/content/generate', { runDate });
    expect(generated.status, JSON.stringify(generated.body)).toBe(200);
    expect(generated.body.data.result.status).toBe('generated');

    const outbox = await api.get('/integrations/dev/outbox');
    // Pick this run's email by its date, never "the last one": the outbox also holds messages from
    // earlier runs against the same dev server, and a stale token would silently test nothing.
    const messages = (outbox.body.data.messages as Array<Record<string, unknown>>).filter((message) =>
      JSON.stringify(message).includes(runDate),
    );
    const body = JSON.stringify(messages.at(-1));
    const token = /token=([A-Za-z0-9._-]+)/.exec(body)?.[1];
    expect(token, 'approval token in the email').toBeTruthy();

    // First use: reject it, so nothing is published by this spec.
    await page.goto(`/approve/?token=${encodeURIComponent(token!)}`);
    // Reject asks for confirmation first - a destructive tap should not be one-tap.
    await page.getByRole('button', { name: /^reject$/i }).click();
    await expect(page.getByText(/reject this post\?/i)).toBeVisible();
    await page.getByRole('button', { name: /confirm reject/i }).click();
    await expect(page.getByRole('heading', { name: /rejected/i })).toBeVisible();

    // Second use: the page must say the link is spent instead of offering the buttons again.
    await page.goto(`/approve/?token=${encodeURIComponent(token!)}`);
    await expect(page.getByText(/already rejected/i)).toBeVisible();
    await expect(page.getByText(/no further action is possible/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^approve$/i })).toHaveCount(0);
    await expect(page.getByText(/link used/i)).toBeVisible();

    const detail = await api.get(`/content/posts/${generated.body.data.result.post.id}`);
    expect(detail.body.data.post.status).toBe('rejected');
  });
});
