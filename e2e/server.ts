/**
 * Boots the REAL app for the end-to-end tests.
 *
 * No HTTP-level mocks: the same Hono app Cloudflare runs serves the API, and the same statically
 * exported Next.js dashboard (out/) is served by it, exactly like `npm run start`. Google Sheets,
 * Gemini, Resend and LinkedIn are the local stubs (SERVICES_MODE=local), so nothing leaves the machine
 * while the code path - validation, database writes, approval tokens, publishing jobs - stays real.
 *
 * Started by the Playwright `webServer` entry in playwright.config.ts, on its own port (8799) so it
 * never collides with `npm run dev`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '@/src/worker/app';

const OUT_DIR = resolve(process.cwd(), 'out');
const port = Number(process.env.E2E_PORT ?? '8799');

if (!existsSync(join(OUT_DIR, 'index.html'))) {
  console.error(
    'The dashboard has not been built, so there is nothing to click.\n' +
      'Run `npm run build` first - `npm run e2e` does it for you.',
  );
  process.exit(1);
}

/** Test config: local services, dev bypass, no background cron (tests drive ticks explicitly). */
function testEnv(): Record<string, string> {
  const fromFile: Record<string, string> = {};
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const at = trimmed.indexOf('=');
      fromFile[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
    }
  }
  return {
    ...fromFile,
    APP_ENV: 'development',
    SERVICES_MODE: 'local',
    ALLOW_DEV_BYPASS: 'true',
    DEV_CRON: 'false',
    OWNER_EMAIL: 'e2e@example.com',
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    // 32 zero bytes, base64 - the config rejects anything that is not exactly 32 bytes.
    APPROVAL_TOKEN_SECRET: 'e2e-approval-secret-0123456789abcdef0123456789abcdef',
    TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    CRON_SECRET: 'e2e-cron-secret',
    // The suite opens ~80 pages in a minute while measuring layout; the per-IP limiter is a
    // production guard, not something a test should trip. It still runs, with a test-sized budget.
    RATE_LIMIT_MAX_REQUESTS: '100000',
    RATE_LIMIT_WINDOW_SECONDS: '60',
  };
}

const config = testEnv();
const app = createApp();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function serveFile(path: string): Promise<Response | null> {
  try {
    const data = await readFile(path);
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return null;
  }
}

// Static export first, API second - the same order the local dev server uses.
app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/api/')) return next();
  const pathname = decodeURIComponent(new URL(c.req.url).pathname);
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(OUT_DIR, safe);
  if (!filePath.startsWith(OUT_DIR)) return c.text('forbidden', 403);
  if (pathname.endsWith('/')) filePath = join(filePath, 'index.html');
  const response =
    (await serveFile(filePath)) ??
    (!extname(pathname) ? await serveFile(join(OUT_DIR, safe, 'index.html')) : null) ??
    (await serveFile(join(OUT_DIR, 'index.html')));
  return response ?? c.text('not found', 404);
});

serve({ fetch: (request) => app.fetch(request, config), port, hostname: '127.0.0.1' }, () => {
  console.log(`e2e app ready on http://127.0.0.1:${port} (services: local)`);
});
