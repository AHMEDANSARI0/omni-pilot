/**
 * Phase 6 QA - the calendar, its day detail and the "Suggest next week" planner, in a real browser
 * at 320 / 390 / 1440 px.
 *
 *   1. start the app:   npm run dev:api          (API + built dashboard on :8787)
 *   2. run the checks:  npm run qa:planning      (or: node docs/qa/planning.mjs)
 *
 * Optional dependency: playwright. It is deliberately NOT in package.json - the browser download is
 * several hundred MB and the app does not need it. Without it the script prints the two commands to
 * run and exits 1. No phase patcher imports playwright (they use Node's standard library only), so
 * `node phase6.mjs` never needs it either.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    [
      'This harness needs a browser. Install it once (dev-only, not part of the app):',
      '',
      '  npm i -D playwright',
      '  npx playwright install chromium',
      '',
      'Everything else - `npm test`, `npm run check:ui`, `node phase6.mjs --check` - works without it.',
    ].join('\n'),
  );
  process.exit(1);
}

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots', 'phase6');
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();

// ---------- API flow: suggest -> accept -> calendar reflects it ----------
const api = await browser.newContext();
const req = api.request;
const suggestRes = await req.post(`${BASE}/api/v1/content/suggestions`, { data: { count: 3 } });
const suggestBody = await suggestRes.json();
if (!suggestBody.ok) console.log('suggest envelope:', JSON.stringify(suggestBody).slice(0, 300));
const suggest = suggestBody.data;
if (!suggest) { console.log('suggestions unavailable; skipping the API flow'); }
check(
  'suggest answers with suggestions or an explained skip list',
  Boolean(suggest) && (suggest.suggestions.length >= 1 || suggest.skipped.length >= 1),
  suggest ? `${suggest.suggestions.length} kept / ${suggest.skipped.length} dropped` : 'n/a',
);

// Accepting an empty list is a validation error by design, so fall back to a known date.
const keep = (suggest?.suggestions ?? []).slice(0, 2);
const payloadTopics = keep.length > 0
  ? keep.map((s) => ({ topicDate: s.topicDate, topic: s.topic, contentType: s.contentType, keyPoints: s.keyPoints, targetAudience: s.targetAudience }))
  : [{ topicDate: '2026-11-27', topic: 'QA fixture topic for the accept path', contentType: 'insight' }];
const acceptRes = await req.post(`${BASE}/api/v1/content/suggestions/accept`, { data: { topics: payloadTopics } });
const accepted = (await acceptRes.json()).data;
check('accept reports what it wrote', accepted !== undefined, `added=${accepted?.added} skipped=${accepted?.skipped?.length}`);

const calRes = await req.get(`${BASE}/api/v1/calendar?month=2026-11`);
const cal = (await calRes.json()).data;
const acceptedDates = payloadTopics.map((t) => t.topicDate);
const pendingDays = cal.weeks.flat().filter((d) => d.kind === 'pending').map((d) => d.date);
check('calendar shows the accepted topics as pending', acceptedDates.every((d) => pendingDays.includes(d)), pendingDays.join(','));
check('accepted dates are no longer reported as gaps', acceptedDates.every((d) => !cal.gaps.includes(d)));
await api.close();

// ---------- UI at 320 / 390 / 1440 ----------
for (const width of [320, 390, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, isMobile: width < 768, hasTouch: width < 768 });
  const page = await context.newPage();
  await page.goto(`${BASE}/calendar/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`[${width}] calendar has no horizontal overflow`, overflow <= 0, `+${overflow}px`);

  const cells = await page.locator('[data-day]').count();
  check(`[${width}] grid renders 35 day cells`, cells === 35, `${cells} cells`);

  const legend = await page.locator('text=Open days').first().isVisible().catch(() => false);
  check(`[${width}] legend explains the colours`, legend);

  // smallest tap target among day cells
  const minCell = await page.evaluate(() => Math.min(...Array.from(document.querySelectorAll('[data-day]')).map((el) => el.getBoundingClientRect().height)));
  check(`[${width}] day cells are >=44px tall`, minCell >= 44, `${Math.round(minCell)}px`);

  // select a day -> detail panel
  await page.locator('[data-day]').nth(16).click();
  await page.waitForTimeout(200);
  const detail = await page.locator('text=Publishing day').first().isVisible().catch(() => false);
  const notPublishing = await page.locator('text=Not a publishing day').first().isVisible().catch(() => false);
  check(`[${width}] tapping a day shows its detail`, detail || notPublishing);

  if (width === 1440) {
    // planner: open, generate, keep-all, add
    await page.click('button:has-text("Plan next week")');
    await page.waitForTimeout(300);
    await page.click('#planner button:has-text("Suggest")');
    await page.waitForTimeout(800);
    const cards = await page.locator("#planner li").count();
    check(`[${width}] planner lists suggestions`, cards >= 1, `${cards} cards`);
    await page.screenshot({ path: `${OUT}/calendar-planner-1440.png` });
  }
  if (width === 320) await page.screenshot({ path: `${OUT}/calendar-320.png` });
  if (width === 390) await page.screenshot({ path: `${OUT}/calendar-390.png` });

  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
