import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 *   npm run e2e            # build the dashboard, start the real app, run every spec
 *   npm run e2e:ui         # same, with the interactive runner
 *
 * The app under test is the production artefact (`next build` static export served by the same Hono
 * app as Cloudflare), with local service stubs. Tests drive the cron tick explicitly, so a run is
 * deterministic instead of racing a background scheduler.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'e2e/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Deterministic by default; the responsive spec creates its own viewports.
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command: 'npx tsx e2e/server.ts',
    url: 'http://127.0.0.1:8799/api/v1/health',
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
