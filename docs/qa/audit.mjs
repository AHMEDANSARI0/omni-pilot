/**
 * PostPilot responsive audit - real Chromium, no guessing.
 *
 *   node audit.mjs <label>        # label = before | after
 *
 * For every page x every width it records:
 *   - horizontal overflow (documentElement.scrollWidth vs innerWidth)
 *   - the exact elements that stick out of the viewport
 *   - tap targets smaller than 44 px (interactive only)
 *   - input font sizes under 16 px on phones
 *   - the sidebar rectangle (so "pinned left" is measurable, not a claim)
 *   - full-page screenshots for the key breakpoints
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const LABEL = process.argv[2] ?? 'run';
const OUT = `/home/user/qa/${LABEL}`;
mkdirSync(OUT, { recursive: true });

const WIDTHS = [320, 360, 390, 414, 768, 1024, 1280, 1440, 1920];
const PAGES = [
  ['/', 'overview'],
  ['/posts/', 'posts'],
  ['/queue/', 'queue'],
  ['/approvals/', 'approvals'],
  ['/history/', 'history'],
  ['/settings/', 'settings'],
  ['/approve/', 'approve'],
  ['/signin/', 'signin'],
];
const SHOT_AT = new Set([320, 390, 768, 1024, 1440, 1920]);

const probe = () => {
  const vw = window.innerWidth;
  const doc = document.documentElement;

  const offenders = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const style = getComputedStyle(el);
    if (style.position === 'fixed') continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const overflowRight = rect.right - vw;
    const overflowLeft = -rect.left;
    if (overflowRight > 1 || overflowLeft > 1) {
      // Report the outermost offender only (skip children of an already reported box).
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 90)) || '',
        right: Math.round(rect.right),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        text: (el.textContent ?? '').trim().slice(0, 40),
      });
    }
  }

  const smallTargets = [];
  const interactive = 'a[href], button, [role="button"], input, select, textarea, summary';
  for (const el of Array.from(document.querySelectorAll(interactive))) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
    if (rect.height < 44 || rect.width < 44) {
      smallTargets.push({
        tag: el.tagName.toLowerCase(),
        label,
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }
  }

  const smallTextInputs = [];
  for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
    const style = getComputedStyle(el);
    if (style.display === 'none') continue;
    const size = parseFloat(style.fontSize);
    if (size < 16) smallTextInputs.push({ size, label: el.getAttribute('aria-label') ?? '' });
  }

  const aside = document.querySelector('aside');
  const asideRect = aside ? aside.getBoundingClientRect() : null;
  const collapsed = aside?.getAttribute('data-collapsed') ?? null;

  const nav = document.querySelector('nav[aria-label="Primary"]');
  const bottomBar = nav ? nav.getBoundingClientRect() : null;

  return {
    vw,
    scrollWidth: doc.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflow: Math.max(doc.scrollWidth, document.body.scrollWidth) - vw,
    offenders: offenders.slice(0, 6),
    offenderCount: offenders.length,
    smallTargets: smallTargets.slice(0, 8),
    smallTargetCount: smallTargets.length,
    smallTextInputs,
    aside: asideRect
      ? {
          left: Math.round(asideRect.left),
          width: Math.round(asideRect.width),
          top: Math.round(asideRect.top),
          height: Math.round(asideRect.height),
          collapsed,
        }
      : null,
    bottomBar: bottomBar ? { top: Math.round(bottomBar.top), h: Math.round(bottomBar.height) } : null,
    hasMenuButton: Boolean(document.querySelector('[data-shell="menu-button"]')),
  };
};

const browser = await chromium.launch();
const results = [];

for (const [width, height] of WIDTHS.map((w) => [w, w < 768 ? 844 : 900])) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: width < 768,
    hasTouch: width < 768,
  });
  const page = await context.newPage();
  for (const [path, name] of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    const data = await page.evaluate(probe);
    results.push({ page: name, path, width, ...data });
    if (SHOT_AT.has(width) && ['overview', 'posts', 'settings'].includes(name)) {
      await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: false });
    }
  }
  await context.close();
}

await browser.close();

const lines = [`# Audit: ${LABEL} @ ${BASE}`, ''];
lines.push('| width | page | overflow px | offenders | small targets | aside left/width | menu btn |');
lines.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  const aside = r.aside ? `${r.aside.left}/${r.aside.width}` : '—';
  lines.push(
    `| ${r.width} | ${r.page} | ${r.overflow > 0 ? `**${r.overflow}**` : 0} | ${r.offenderCount} | ${r.smallTargetCount} | ${aside} | ${r.hasMenuButton ? 'yes' : 'no'} |`,
  );
}

const overflowing = results.filter((r) => r.overflow > 0);
lines.push('', '## Overflow details', '');
if (overflowing.length === 0) lines.push('None. Every page fits horizontally at every width.');
for (const r of overflowing) {
  lines.push(`### ${r.page} @ ${r.width}px (+${r.overflow}px)`);
  for (const o of r.offenders) {
    lines.push(`- \`<${o.tag}>\` left=${o.left} right=${o.right} w=${o.width} — "${o.text}"`);
  }
  lines.push('');
}

const sidebars = new Map();
for (const r of results) {
  if (!r.aside) continue;
  const key = r.width;
  if (!sidebars.has(key)) sidebars.set(key, r.aside);
}
lines.push('## Sidebar geometry (first page measured per width)', '');
for (const [width, aside] of sidebars) {
  lines.push(`- ${width}px → left ${aside.left}, width ${aside.width}, top ${aside.top}, h ${aside.height}`);
}

lines.push('', '## Tap targets under 44 px (first offenders per page)', '');
const seen = new Set();
for (const r of results) {
  if (r.smallTargetCount === 0) continue;
  const key = r.page;
  if (seen.has(key)) continue;
  seen.add(key);
  lines.push(`- **${r.page}** @ ${r.width}: ${r.smallTargets.map((t) => `${t.tag}"${t.label}" ${t.w}x${t.h}`).join(', ')}`);
}

lines.push('', '## Inputs under 16 px on phone widths', '');
const smallInputs = results.filter((r) => r.width <= 414 && r.smallTextInputs.length > 0);
if (smallInputs.length === 0) lines.push('None.');
else
  for (const r of smallInputs)
    lines.push(`- ${r.page} @ ${r.width}: ${JSON.stringify(r.smallTextInputs.slice(0, 4))}`);

writeFileSync(`${OUT}/report.md`, lines.join('\n'));
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(lines.join('\n'));
