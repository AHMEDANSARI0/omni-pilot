#!/usr/bin/env node
/**
 * Why is the app not seeing my Supabase keys?
 *
 *   node scripts/env-check.mjs
 *
 * `npm run db:verify` prints "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required" for at least six
 * different reasons, and they need completely different fixes: the keys are in another folder, the file is
 * named `.env.local.txt`, the line is commented out, the value is quoted so it arrives with a stray `"`, or
 * - the one that looks like success right up until the first query - the *anon* key was pasted where the
 * service role key belongs. This prints which one it is.
 *
 * No dependencies and no network: it only reads files and decodes the key you already have.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const ok = (text) => console.log(`  ${paint(32, 'ok  ')} ${text}`);
const bad = (text) => console.log(`  ${paint(31, 'FAIL')} ${text}`);
const warn = (text) => console.log(`  ${paint(33, 'warn')} ${text}`);
const info = (text) => console.log(`        ${paint(90, text)}`);
const head = (text) => console.log(`\n  ${paint(1, text)}`);

const WANTED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];

/** Never print a secret: enough to recognise it, not enough to use it. */
function mask(value) {
  if (value.length <= 12) return `${'*'.repeat(Math.max(value.length, 3))} (${value.length} chars)`;
  return `${value.slice(0, 8)}…${value.slice(-4)} (${value.length} chars)`;
}

/**
 * Reads a `.env` file the way Node's own loader does, and records the problems a loader silently ignores.
 * Returns the map plus one note per line that will not do what the owner expects.
 */
function parseEnvFile(path) {
  const values = new Map();
  const notes = [];
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const name = line.replace(/^#+\s*/, '').split('=')[0]?.trim();
      if (name && WANTED.includes(name)) {
        notes.push(`line ${index + 1}: ${name} is commented out — delete the leading "#" to switch it on`);
      }
      continue;
    }
    const at = line.indexOf('=');
    if (at === -1) {
      if (WANTED.some((name) => line.startsWith(name))) {
        notes.push(`line ${index + 1}: no "=" - a key needs KEY=value on one line`);
      }
      continue;
    }
    let name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (name.startsWith('export ')) {
      name = name.slice('export '.length).trim();
      notes.push(`line ${index + 1}: "export " is shell syntax - harmless here, but drop it`);
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      notes.push(`line ${index + 1}: ${name} is wrapped in quotes - the quotes become part of the value`);
      value = value.slice(1, -1);
    }
    if (/\s/.test(value) && !value.includes(' ')) notes.push(`line ${index + 1}: ${name} has odd whitespace`);
    if (name in Object.fromEntries(values)) notes.push(`line ${index + 1}: ${name} appears twice`);
    values.set(name, value);
  }
  return { values, notes };
}

/**
 * A Supabase key is a JWT: header.payload.signature. The payload says which role it is, which is the whole
 * difference between "works" and "silently sees nothing".
 */
function jwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- where am I */

head('Where this ran');
console.log(`  ${paint(1, ROOT)}`);
info(`node ${process.version} · ${process.platform}`);
info('`npm run db:verify` reads .env.local from THIS folder. If your keys are in another project copy,');
info('that is the whole problem - the folder below must match the one holding your .env.local.');

/* -------------------------------------------------------- sibling folder detection */

const parent = dirname(ROOT);
const siblings = [];
try {
  for (const entry of readdirSync(parent)) {
    const dir = join(parent, entry);
    if (dir === ROOT) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of ['.env.local', '.env']) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      try {
        const { values } = parseEnvFile(file);
        if (values.get('SUPABASE_URL') && values.get('SUPABASE_SERVICE_ROLE_KEY')) {
          siblings.push(join(dir, name));
        }
      } catch {
        // Unreadable is not interesting here.
      }
    }
  }
} catch {
  // A parent that cannot be listed is fine - the rest of the report still helps.
}

/* ------------------------------------------------------------------ the files */

head('Environment files in this folder');
const CANDIDATES = [
  '.env.local',
  '.env',
  '.env.local.txt',
  '.env.txt',
  '.env.local.example',
  '.env.example',
];
const found = [];
let chosen = null;

for (const name of CANDIDATES) {
  const path = join(ROOT, name);
  if (!existsSync(path)) continue;
  let parsed;
  try {
    parsed = parseEnvFile(path);
  } catch (error) {
    bad(`${name} exists but cannot be read: ${error.message}`);
    continue;
  }
  const present = WANTED.filter((key) => parsed.values.get(key));
  found.push({ name, parsed, present });
  if (name === '.env.local' || name === '.env') {
    ok(`${name} — ${present.length ? present.join(', ') : 'no Supabase keys'}`);
  } else {
    warn(`${name} — this name is NOT read by the app (does Notepad add .txt?)`);
  }
  for (const note of parsed.notes) info(note);
  if (!chosen && present.includes('SUPABASE_URL') && present.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    chosen = { name, ...parsed };
  }
}

if (found.length === 0) {
  bad('no .env.local and no .env in this folder');
  info('create .env.local next to package.json with:');
  info('  SUPABASE_URL=https://<ref>.supabase.co');
  info('  SUPABASE_SERVICE_ROLE_KEY=<service-role-key>');
}

/* --------------------------------------------------------------- the two keys */

head('The two keys');

if (!chosen) {
  bad('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not both usable in .env.local / .env');
  const partial = found.find((file) => file.name === '.env.local' || file.name === '.env');
  const commented = partial?.parsed.notes ?? [];
  for (const key of WANTED.slice(0, 2)) {
    const value = partial?.parsed.values.get(key);
    if (value) {
      warn(`${key} — present but the other one is missing`);
      continue;
    }
    const off = commented.find((note) => note.includes(key) && note.includes('commented out'));
    bad(off ? `${key} — ${off}` : `${key} — missing`);
  }
  info('A commented-out line looks set in Notepad but the app never sees it. That is the usual cause.');
  if (siblings.length > 0) {
    head('Likely cause: your keys are in a different copy of the project');
    for (const path of siblings) {
      console.log(`  ${paint(35, '->')} ${path}`);
    }
    info('Either run the command from that folder, or copy the two lines into this one\'s .env.local.');
  }
} else {
  const url = chosen.values.get('SUPABASE_URL') ?? '';
  const serviceKey = chosen.values.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anonKey = chosen.values.get('SUPABASE_ANON_KEY') ?? '';

  if (/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url)) {
    ok(`SUPABASE_URL looks right — ${url.replace(/\/$/, '')}`);
  } else if (/^https?:\/\//.test(url)) {
    warn(`SUPABASE_URL is a URL but not the project URL shape: ${url}`);
    info('expected https://<ref>.supabase.co (no /rest/v1, no trailing path)');
  } else {
    bad(`SUPABASE_URL is not a URL: ${mask(url)}`);
  }

  const serviceRole = jwtRole(serviceKey);
  const anonRole = anonKey ? jwtRole(anonKey) : null;
  if (serviceRole === 'service_role') {
    ok(`SUPABASE_SERVICE_ROLE_KEY is the service_role key — ${mask(serviceKey)}`);
  } else if (serviceRole === 'anon') {
    bad('SUPABASE_SERVICE_ROLE_KEY holds the ANON key');
    info('Both are long JWTs and they sit next to each other in the dashboard. `db:verify` would connect');
    info('and then see no tables, because anon is blocked by RLS. Use the key labelled "service_role".');
  } else if (serviceKey.startsWith('sb_secret_')) {
    // The current format. New projects (created or restored since late 2025) do not get a legacy JWT at
    // all, so this is the normal case now, not a problem - it maps to the same service_role.
    ok(`SUPABASE_SERVICE_ROLE_KEY is a secret key (sb_secret_) — ${mask(serviceKey)}`);
    info('Current key format. Maps to the service_role, so it bypasses RLS exactly like the legacy JWT.');
  } else if (serviceKey.startsWith('sb_publishable_')) {
    bad('SUPABASE_SERVICE_ROLE_KEY holds a PUBLISHABLE key (sb_publishable_)');
    info('That is the browser-side key. It maps to anon, so RLS hides every row and db:verify fails.');
    info('Use the secret key (sb_secret_...) or the legacy service_role JWT.');
  } else if (serviceKey.startsWith('sb_')) {
    warn(`SUPABASE_SERVICE_ROLE_KEY starts with "sb_" but not a key prefix I recognise — ${mask(serviceKey)}`);
  } else if (serviceKey.length > 20) {
    warn(`SUPABASE_SERVICE_ROLE_KEY is set but is not a decodable JWT — ${mask(serviceKey)}`);
  } else {
    bad(`SUPABASE_SERVICE_ROLE_KEY looks truncated — ${mask(serviceKey)}`);
  }

  if (anonKey && anonRole === 'service_role') {
    warn('SUPABASE_ANON_KEY holds the service_role key - those two are the wrong way round');
  }

  const urlRef = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(url)?.[1];
  const keyRef = (() => {
    const parts = serviceKey.split('.');
    if (parts.length !== 3) return null;
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).ref ?? null;
    } catch {
      return null;
    }
  })();
  if (urlRef && keyRef && urlRef !== keyRef) {
    bad(`SUPABASE_URL and the key belong to different projects (${urlRef} vs ${keyRef})`);
    info('A key from project A against project B fails in ways that read like "no tables".');
  } else if (urlRef && keyRef) {
    ok(`URL and key are from the same project (${urlRef})`);
  }
}

/* ------------------------------------------------------------- what to do next */

head('Next');
if (chosen) {
  console.log('  Keys are readable. Run:');
  console.log(`    ${paint(1, 'npm run db:verify')}`);
  info('Then, if the migration has not been applied yet, paste');
  info('supabase/migrations/0005_slots_and_api.sql into the Supabase SQL Editor and press Run.');
} else {
  console.log('  Fix the line(s) above, save .env.local, and run this again:');
  console.log(`    ${paint(1, 'node scripts/env-check.mjs')}`);
}

console.log('');
process.exit(chosen ? 0 : 1);
