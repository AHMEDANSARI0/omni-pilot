import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '@/src/worker/app';

/**
 * Local development server: the same Hono app that runs on Cloudflare Workers, plus the
 * statically exported Next.js dashboard. Mirrors production routing exactly.
 *
 *   npm run dev:api            # API + dashboard on http://localhost:8787
 *   npm run dev                # Next dev server (3000) + API (8787) with rewrites
 */
const app = createApp();
const OUT_DIR = resolve(process.cwd(), 'out');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

async function serveFile(filePath: string): Promise<Response | null> {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    const data = await readFile(filePath);
    return new Response(new Blob([data]), {
      headers: {
        'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': filePath.endsWith('.html') ? 'no-store' : 'public, max-age=60',
      },
    });
  } catch {
    return null;
  }
}

app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/api/')) return next();
  const url = new URL(c.req.url);
  let pathname = decodeURIComponent(url.pathname);
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(OUT_DIR, safePath);
  if (!filePath.startsWith(OUT_DIR)) return next();

  if (pathname.endsWith('/')) filePath = join(filePath, 'index.html');
  let response = await serveFile(filePath);
  if (!response && !extname(pathname)) {
    response = await serveFile(join(OUT_DIR, safePath, 'index.html'));
  }
  if (response) return response;

  if (pathname.startsWith('/_next/'))
    return c.text('Static asset not found. Run `npm run build`.', 404);

  const spa = await serveFile(join(OUT_DIR, 'index.html'));
  if (spa) return spa;
  return c.text(
    'Dashboard build not found. Run `npm run build` first, or use `npm run dev` for hot reload.',
    404,
  );
});

const port = Number(process.env.PORT ?? 8787);

serve(
  { fetch: (request) => app.fetch(request, process.env), port, hostname: '0.0.0.0' },
  (info) => {
    console.log(`API + dashboard listening on http://0.0.0.0:${info.port}`);
    if (process.env.ALLOW_DEV_BYPASS === 'true') {
      console.log('DEV BYPASS ENABLED: dashboard API is unauthenticated for local development.');
    }
    if (!existsSync(join(OUT_DIR, 'index.html'))) {
      console.log('No dashboard build found in ./out - API-only until you run `npm run build`.');
    }
  },
);

if (process.env.DEV_CRON === 'true') {
  const intervalMs = 5 * 60_000;
  console.log(
    'DEV CRON enabled: automation tick every 5 minutes (production uses Cloudflare Cron).',
  );
  setInterval(async () => {
    try {
      const { createServices } = await import('@/src/server/services');
      const { runAutomationTick } = await import('@/src/core/scheduler');
      const services = await createServices(process.env);
      const result = await runAutomationTick(services, { trigger: 'cron' });
      console.log(
        `[dev-cron] generation=${result.generation.reason} published=${result.publishing.length}`,
      );
    } catch (error) {
      console.error('[dev-cron] tick failed', error);
    }
  }, intervalMs);
}

void createReadStream;
