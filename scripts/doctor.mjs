#!/usr/bin/env node
/**
 * Environment doctor: checks the things that actually stop `npm run dev:api` from working,
 * and prints the exact command that fixes each problem.
 *
 *   npm run doctor
 *   node scripts/doctor.mjs
 *
 * Exit codes: 0 = healthy (warnings allowed), 1 = at least one blocking problem.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const ok = (text) => console.log(`  ${paint(32, 'PASS')}  ${text}`);
const warn = (text) => console.log(`  ${paint(33, 'WARN')}  ${text}`);
const fail = (text) => console.log(`  ${paint(31, 'FAIL')}  ${text}`);
const hint = (text) => console.log(`        ${paint(90, '→ ' + text)}`);

const problems = [];
const warnings = [];

function read(file) {
  try {
    return readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return null;
  }
}

function parseEnv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    map.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
  }
  return map;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

console.log('\n  PostPilot doctor\n  ---------------');

/* 1. Node version ---------------------------------------------------------- */
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node ${process.version}`);
else {
  fail(`Node ${process.version} is too old (need 20 or newer)`);
  hint('install Node 22:  nvm install 22 && nvm use 22   (or download from nodejs.org)');
  problems.push('node');
}

/* 2. Project layout -------------------------------------------------------- */
const requiredFiles = ['package.json', 'tsconfig.json', 'next.config.mjs', 'src/dev/node.ts'];
const missingFiles = requiredFiles.filter((file) => !existsSync(join(ROOT, file)));
if (missingFiles.length === 0) ok('project files present');
else {
  fail(`not a project root - missing ${missingFiles.join(', ')}`);
  hint('run the doctor from the folder that contains package.json');
  problems.push('layout');
}

/* 3. Dependencies ---------------------------------------------------------- */
if (
  existsSync(join(ROOT, 'node_modules', 'tsx')) &&
  existsSync(join(ROOT, 'node_modules', 'next'))
) {
  ok('dependencies installed');
} else {
  fail('node_modules missing or incomplete');
  hint('npm ci');
  problems.push('deps');
}

/* 4. Environment file ------------------------------------------------------ */
const envText = read('.env.local');
const env = envText ? parseEnv(envText) : new Map();

if (!envText) {
  fail('.env.local not found');
  hint('node scripts/init-env.mjs you@gmail.com');
  problems.push('env');
} else {
  ok('.env.local found');

  const required = [
    'APP_ENV',
    'OWNER_EMAIL',
    'APPROVAL_TOKEN_SECRET',
    'TOKEN_ENCRYPTION_KEY',
    'SERVICES_MODE',
  ];
  const missing = required.filter((key) => !env.get(key));
  if (missing.length === 0) ok('required keys present');
  else {
    fail(`missing keys: ${missing.join(', ')}`);
    hint('node scripts/init-env.mjs --force   (regenerates a complete local file)');
    problems.push('env-keys');
  }

  const tokenSecret = env.get('APPROVAL_TOKEN_SECRET') ?? '';
  if (tokenSecret && tokenSecret.length < 32) {
    fail('APPROVAL_TOKEN_SECRET must be at least 32 characters');
    hint('openssl rand -hex 32   → paste into .env.local');
    problems.push('token-secret');
  }

  const key = env.get('TOKEN_ENCRYPTION_KEY') ?? '';
  if (key) {
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length !== 32)
      warn('TOKEN_ENCRYPTION_KEY should be 32 bytes of base64 (openssl rand -base64 32)');
  }

  const appEnv = (env.get('APP_ENV') ?? '').toLowerCase();
  const servicesMode = (env.get('SERVICES_MODE') ?? '').toLowerCase();
  const devBypass = (env.get('ALLOW_DEV_BYPASS') ?? '').toLowerCase() === 'true';

  if (appEnv === 'production' && devBypass) {
    fail('APP_ENV=production with ALLOW_DEV_BYPASS=true - the app will refuse to start');
    hint('remove ALLOW_DEV_BYPASS from .env.local (it is local-only by design)');
    problems.push('dev-bypass');
  }
  if (appEnv === 'production' && servicesMode === 'local') {
    fail('APP_ENV=production with SERVICES_MODE=local - the app will refuse to start');
    hint('set SERVICES_MODE=live and provide the real credentials');
    problems.push('local-in-prod');
  }
  if (appEnv !== 'production' && servicesMode === 'live') {
    warn('SERVICES_MODE=live: real emails/posts can be sent from this machine');
  }
  if (appEnv !== 'production' && !devBypass) {
    warn('ALLOW_DEV_BYPASS is off locally - the dashboard will ask for a Supabase login');
  }
  if (servicesMode === 'live') {
    const live = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_CLIENT_ID',
      'RESEND_API_KEY',
      'LINKEDIN_CLIENT_ID',
    ];
    const missingLive = live.filter((name) => !env.get(name));
    if (missingLive.length > 0) {
      fail(`SERVICES_MODE=live but these are empty: ${missingLive.join(', ')}`);
      hint('see docs/SETUP.md §1-7, or set SERVICES_MODE=local to keep everything stubbed');
      problems.push('live-keys');
    } else ok('live credentials provided');
  }
}

/* 4b. WhatsApp approval channel (optional) ---------------------------------- */
const waKeys = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_OWNER_NUMBER'];
const waPresent = waKeys.filter((name) => env.get(name));
if (waPresent.length === 0) {
  ok('WhatsApp approvals off (optional) - email approvals only');
} else if (waPresent.length < waKeys.length) {
  const missingWa = waKeys.filter((name) => !env.get(name));
  warn(`WhatsApp partly configured - missing ${missingWa.join(', ')}`);
  hint('see docs/WHATSAPP.md; the channel stays off until all three are set');
  warnings.push('whatsapp');
} else {
  ok('WhatsApp approvals configured');
  if (!env.get('WHATSAPP_APP_SECRET') || !env.get('WHATSAPP_VERIFY_TOKEN')) {
    warn('WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN missing - Meta cannot verify the webhook');
    hint('set both, then re-subscribe the webhook in the Meta app dashboard');
    warnings.push('whatsapp-verify');
  }
}

/* 5. Dashboard build ------------------------------------------------------- */
const builtHtml = join(ROOT, 'out', 'index.html');
if (existsSync(builtHtml)) {
  ok('dashboard build found (out/index.html)');
  const stat = readFileSync(join(ROOT, 'out', 'index.html'));
  if (stat.length < 200) warn('out/index.html looks truncated - rebuild with npm run build');
} else {
  fail('dashboard not built yet (out/index.html missing)');
  hint('npm run build');
  problems.push('build');
}

/* 6. Port ------------------------------------------------------------------ */
const port = Number(env.get('PORT') ?? process.env.PORT ?? 8787);
const free = await portFree(port);
if (free) ok(`port ${port} is free`);
else {
  warn(`port ${port} is already in use - maybe the server is already running`);
  hint(
    'open http://localhost:' +
      port +
      '   or   PORT=8790 npm run dev:api  (PowerShell: $env:PORT=8790; npm run dev:api)',
  );
  warnings.push('port');
}

/* 7. Git state (informational) -------------------------------------------- */
if (existsSync(join(ROOT, '.git'))) ok('git repository detected');
else warn('no .git folder - fine if you only want to run the project');

/* Summary ------------------------------------------------------------------ */
if (!quiet) {
  console.log('\n  ------------------------------------------------');
  if (problems.length === 0) {
    console.log(`  ${paint(32, 'Ready.')} Start the app with:  ${paint(1, 'npm run dev:api')}`);
    console.log(`  Then open ${paint(36, `http://localhost:${port}`)}`);
    if (warnings.length > 0) console.log(`  ${warnings.length} warning(s) above are non-blocking.`);
  } else {
    console.log(
      `  ${paint(31, problems.length + ' blocking problem(s).')} Fix them in the order shown above.`,
    );
  }
  console.log('');
}

process.exit(problems.length > 0 ? 1 : 0);
