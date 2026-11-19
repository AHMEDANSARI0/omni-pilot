/**
 * Interaction QA for the Phase 5 shell - real browser, real clicks.
 *
 *   node interactions.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();

/* ---------------------------------------------------------------- desktop */
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await desktop.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const aside = page.locator('#shell-sidebar');
const box = await aside.boundingBox();
check('rail pinned to the left edge', Math.round(box.x) === 0, `x=${Math.round(box.x)}`);
check('rail is 264px expanded', Math.round(box.width) === 264, `w=${Math.round(box.width)}`);
check('rail fills the viewport height', Math.round(box.height) === 900, `h=${Math.round(box.height)}`);

const mainLeft = await page.evaluate(() => document.querySelector('main').getBoundingClientRect().left);
check('content starts right after the rail', Math.round(mainLeft) === 264, `main.left=${Math.round(mainLeft)}`);

// scroll and confirm the rail does not move
await page.evaluate(() => window.scrollTo(0, 1200));
await page.waitForTimeout(200);
const boxAfterScroll = await aside.boundingBox();
check('rail does not scroll away', Math.round(boxAfterScroll.y) === 0, `y=${Math.round(boxAfterScroll.y)}`);
await page.evaluate(() => window.scrollTo(0, 0));

// collapse
await page.click('[data-shell="sidebar-toggle"]');
await page.waitForTimeout(350);
const collapsedBox = await aside.boundingBox();
check('collapses to a 72px icon rail', Math.round(collapsedBox.width) === 72, `w=${Math.round(collapsedBox.width)}`);
check(
  'html data-sidebar reflects the state',
  (await page.getAttribute('html', 'data-sidebar')) === 'collapsed',
);
check('toggle reports aria-expanded=false', (await page.getAttribute('[data-shell="sidebar-toggle"]', 'aria-expanded')) === 'false');
check('localStorage remembers the choice', (await page.evaluate(() => localStorage.getItem('postpilot.sidebar'))) === 'collapsed');
const collapsedLayout = await page.evaluate(() => {
  const main = document.querySelector('main').getBoundingClientRect();
  return { left: Math.round(main.left), width: Math.round(main.width) };
});
check(
  'content reflows when collapsed (starts after the 72px rail, still capped)',
  collapsedLayout.left >= 72 && collapsedLayout.width <= 1180,
  `main.left=${collapsedLayout.left} main.width=${collapsedLayout.width}`,
);

// tooltip on hover (CSS only, so measure visibility)
await page.hover('#shell-sidebar a[href="/posts/"]');
await page.waitForTimeout(200);
const tipOpacity = await page.evaluate(() => {
  const tip = document.querySelector('#shell-sidebar a[href="/posts/"] [role="tooltip"]');
  return tip ? getComputedStyle(tip).opacity : null;
});
check('collapsed rail shows a tooltip on hover', tipOpacity === '1', `opacity=${tipOpacity}`);

// persistence across navigation + reload
await page.goto(`${BASE}/posts/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const persisted = await aside.boundingBox();
check('choice survives navigation', Math.round(persisted.width) === 72, `w=${Math.round(persisted.width)}`);

// keyboard shortcut
await page.keyboard.press('[');
await page.waitForTimeout(300);
const expandedAgain = await aside.boundingBox();
check('"[" expands the rail again', Math.round(expandedAgain.width) === 264, `w=${Math.round(expandedAgain.width)}`);

await desktop.close();

/* ----------------------------------------------------------------- mobile */
for (const width of [320, 390, 768]) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    isMobile: width < 768,
    hasTouch: width < 768,
  });
  const m = await context.newPage();
  await m.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await m.waitForTimeout(300);

  const menu = m.locator('[data-shell="menu-button"]');
  check(`[${width}] menu button visible`, await menu.isVisible());

  const drawerBefore = await m.locator('[data-shell="drawer-panel"]').count();
  check(`[${width}] no drawer in the DOM while closed`, drawerBefore === 0);

  await menu.click();
  await m.waitForTimeout(250);
  const drawer = m.locator('[data-shell="drawer-panel"]');
  check(`[${width}] drawer opens`, await drawer.isVisible());

  const bodyOverflow = await m.evaluate(() => getComputedStyle(document.body).overflow);
  check(`[${width}] page scroll is locked`, bodyOverflow === 'hidden', `overflow=${bodyOverflow}`);

  const focusInDrawer = await m.evaluate(
    () => document.querySelector('[data-shell="drawer-panel"]').contains(document.activeElement),
  );
  check(`[${width}] focus moves into the drawer`, focusInDrawer);

  const drawerBox = await drawer.boundingBox();
  check(`[${width}] drawer hugs the left edge`, Math.round(drawerBox.x) <= 8, `x=${Math.round(drawerBox.x)}`);
  check(`[${width}] drawer fits the screen`, drawerBox.width <= width, `w=${Math.round(drawerBox.width)} of ${width}`);

  // Escape closes
  await m.keyboard.press('Escape');
  await m.waitForTimeout(250);
  check(`[${width}] Escape closes the drawer`, (await m.locator('[data-shell="drawer-panel"]').count()) === 0);

  // backdrop closes
  await menu.click();
  await m.waitForTimeout(200);
  await m.click('[data-shell="drawer-backdrop"]', { position: { x: width - 12, y: 40 } });
  await m.waitForTimeout(250);
  check(`[${width}] backdrop tap closes the drawer`, (await m.locator('[data-shell="drawer-panel"]').count()) === 0);

  // navigating from the drawer closes it
  await menu.click();
  await m.waitForTimeout(200);
  await m.click('[data-shell="drawer-panel"] a[href="/posts/"]');
  await m.waitForTimeout(500);
  check(`[${width}] navigating closes the drawer`, (await m.locator('[data-shell="drawer-panel"]').count()) === 0);

  const overflow = await m.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(`[${width}] no horizontal page overflow`, overflow <= 0, `+${overflow}px`);

  const bottomBar = await m.locator('nav[aria-label="Primary"]').isVisible();
  check(`[${width < 1024 ? width : 1024}] bottom tab bar still present below lg`, bottomBar || width >= 1024);

  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
