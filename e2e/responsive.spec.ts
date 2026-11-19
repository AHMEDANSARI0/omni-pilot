/**
 * Responsive sweep: every page, nine widths, on the built dashboard.
 *
 * The rule the product promises (docs/ROADMAP.md): 320 px to 1920 px, no horizontal scroll, tap
 * targets at least 44 px on phones, inputs at 16 px so iOS does not zoom. Phase 5 measured this once
 * by hand; this spec keeps it true on every run.
 *
 * Widths: 320, 360, 390 (phones), 768 (tablet), 1024 (rail breakpoint), 1280, 1440, 1728, 1920.
 * 320 and 1920 are the contract; the rest catch regressions in between.
 */
import { expect } from '@playwright/test';
import { test } from './fixtures';

const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1440, 1728, 1920];
const PAGES = [
  ['overview', '/'],
  ['queue', '/queue/'],
  ['calendar', '/calendar/'],
  ['hooks', '/hooks/'],
  ['posts', '/posts/'],
  ['approvals', '/approvals/'],
  ['history', '/history/'],
  ['settings', '/settings/'],
] as const;

/** Widths where a phone layout is expected (bottom nav, no sidebar). */
const PHONE_MAX = 390;

for (const [name, path] of PAGES) {
  test(`${name}: no horizontal scroll at any width`, async ({ page, evidence }) => {
    void evidence;
    const problems: string[] = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path, { waitUntil: 'networkidle' });

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (overflow > 0) problems.push(`${width}px: ${overflow}px of horizontal overflow`);

      // Nothing may stick out of the viewport, unless it lives inside a deliberate horizontal
      // scroller (the filter/tab rails use `overflow-x-auto`, so their children legitimately extend
      // past the edge while the page itself never scrolls sideways).
      const offenders = await page.evaluate(() => {
        const inScroller = (element: Element): boolean => {
          let node = element.parentElement;
          while (node) {
            const style = window.getComputedStyle(node);
            if (style.overflowX === 'auto' || style.overflowX === 'scroll') return true;
            node = node.parentElement;
          }
          return false;
        };
        const wide: string[] = [];
        for (const element of Array.from(document.querySelectorAll('body *'))) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (box.right <= window.innerWidth + 1) continue;
          if (inScroller(element)) continue;
          wide.push(`${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
        }
        return wide.slice(0, 3);
      });
      if (offenders.length > 0) problems.push(`${width}px: elements past the right edge: ${offenders.join(', ')}`);

      if (width <= PHONE_MAX) {
        // Touch targets: interactive elements must be at least 44 px tall on a phone.
        const small = await page.evaluate(() => {
          const tiny: string[] = [];
          const nodes = document.querySelectorAll('button, a[href], input, select, textarea');
          for (const node of Array.from(nodes)) {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const box = node.getBoundingClientRect();
            if (box.height === 0) continue;
            // Inline links inside a paragraph are text, not tap targets.
            if (style.display === 'inline') continue;
            if (box.height < 44) tiny.push(`${node.tagName.toLowerCase()}:${(node.textContent ?? '').trim().slice(0, 18)}=${Math.round(box.height)}px`);
          }
          return tiny.slice(0, 5);
        });
        if (small.length > 0) problems.push(`${width}px: tap targets under 44px: ${small.join(', ')}`);

        // iOS zooms on focus when an input is smaller than 16 px.
        const zoom = await page.evaluate(() => {
          const small: string[] = [];
          for (const node of Array.from(document.querySelectorAll('input, textarea, select'))) {
            const style = window.getComputedStyle(node);
            if (style.display === 'none') continue;
            const size = Number.parseFloat(style.fontSize);
            if (size < 16) small.push(`${node.tagName.toLowerCase()}=${size}px`);
          }
          return small;
        });
        if (zoom.length > 0) problems.push(`${width}px: inputs under 16px (iOS zoom): ${zoom.join(', ')}`);
      }
    }

    expect(problems, `${name} responsive problems`).toEqual([]);
  });
}

test('phone layout: bottom nav replaces the sidebar, drawer opens and closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/queue/');

  // The sidebar is hidden below lg, and the bottom tab bar is the navigation.
  await expect(page.getByRole('navigation', { name: /primary/i })).toBeVisible();
  const sidebar = page.getByRole('complementary', { name: /sidebar/i });
  await expect(sidebar).toBeHidden();

  // The drawer is a separate sheet with its own accessible name; it closes with Escape.
  await page.getByRole('button', { name: /open menu|menu/i }).first().click();
  const drawer = page.getByRole('complementary', { name: /workspace menu/i });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('desktop layout: sidebar is pinned to the left edge and can collapse', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/queue/');

  const sidebar = page.getByRole('complementary', { name: /sidebar/i });
  await expect(sidebar).toBeVisible();
  const box = await sidebar.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width).toBeGreaterThan(200);

  const expandedWidth = box?.width ?? 0;
  await page.getByRole('button', { name: /collapse sidebar/i }).click();
  // Wait for the transition to settle before measuring.
  await page.waitForTimeout(400);
  const collapsed = await sidebar.boundingBox();
  expect(collapsed?.width ?? expandedWidth).toBeLessThan(expandedWidth);

  // The choice survives a reload (localStorage), and does not break the page.
  await page.reload();
  await page.waitForTimeout(400);
  const persisted = await sidebar.boundingBox();
  expect(persisted?.width ?? expandedWidth).toBeLessThan(expandedWidth);
});
