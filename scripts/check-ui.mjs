#!/usr/bin/env node
/**
 * UI separation guard.
 *
 *   npm run check:ui
 *
 * Fails when the design system stops being replaceable:
 *   1. a raw colour (Tailwind palette class, hex, hsl()/rgb()) appears outside `ui/`
 *   2. `lucide-react` is imported anywhere except `ui/icons.tsx`
 *   3. something inside `ui/` imports application code (lib, src, components, app)
 *
 * `tests/ui-separation.test.ts` runs the same checks, so CI enforces it too.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PALETTE =
  /\b(?:bg|text|border|from|via|to|ring|ring-offset|divide|shadow|fill|stroke|outline|placeholder|decoration|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNCTIONAL_COLOUR = /\b(?:hsla?|rgba?)\(/g;
const LUCIDE = /from\s+'lucide-react'/g;
const APP_IMPORT = /from\s+'@\/(?:lib|src|components|app)(?:\/[^']*)?'/g;

const SCAN_DIRS = ['app', 'components', 'lib', 'ui'];
const EXTENSIONS = ['.ts', '.tsx', '.css'];
/** Files allowed to contain raw colour literals (the theme itself). */
const COLOUR_ALLOWLIST = new Set([
  'ui/tokens.css',
  'ui/theme.ts',
  'ui/primitives.tsx',
  'app/layout.tsx', // themeColor for the browser chrome
]);

function walk(root, dir, out = []) {
  let entries;
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(root, dir, entry);
    const relativePath = relative(root, full).split(sep).join('/');
    if (statSync(full).isDirectory()) walk(root, relativePath, out);
    else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) out.push(relativePath);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * @param {string} root project root
 * @returns {Array<{ file: string, line: number, rule: string, match: string }>}
 */
export function checkUi(root) {
  const files = SCAN_DIRS.flatMap((dir) => walk(root, dir));
  const violations = [];

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const isUi = file.startsWith('ui/');
    const colourAllowed = COLOUR_ALLOWLIST.has(file);

    if (!colourAllowed) {
      for (const [regex, rule] of [
        [PALETTE, 'raw Tailwind palette colour'],
        [HEX, 'hard-coded hex colour'],
        [FUNCTIONAL_COLOUR, 'hard-coded hsl()/rgb() colour'],
      ]) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text))) {
          violations.push({ file, line: lineOf(text, match.index), rule, match: match[0] });
        }
      }
    }

    if (file !== 'ui/icons.tsx') {
      LUCIDE.lastIndex = 0;
      let match;
      while ((match = LUCIDE.exec(text))) {
        violations.push({
          file,
          line: lineOf(text, match.index),
          rule: 'direct lucide-react import (use ui/icons.tsx)',
          match: match[0],
        });
      }
    }

    if (isUi) {
      APP_IMPORT.lastIndex = 0;
      let match;
      while ((match = APP_IMPORT.exec(text))) {
        violations.push({
          file,
          line: lineOf(text, match.index),
          rule: 'ui/ must not depend on application code',
          match: match[0],
        });
      }
    }
  }

  return violations;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-ui.mjs');
if (invokedDirectly) {
  const root = process.cwd();
  const violations = checkUi(root);

  if (violations.length === 0) {
    console.log('\n  UI separation: clean. Design lives in ui/ only.\n');
    process.exit(0);
  }

  console.error(`\n  UI separation: ${violations.length} problem(s)\n`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.rule} → ${violation.match}`);
  }
  console.error(
    '\n  Colours belong in ui/tokens.css, icons in ui/icons.tsx, components in ui/primitives.tsx.\n',
  );
  process.exit(1);
}
