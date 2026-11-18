import { createServices } from '@/src/server/services';
import { runAutomationTick } from '@/src/core/scheduler';

/**
 * Run one automation tick from the command line (same code path as the Cloudflare cron).
 * Useful for a first end-to-end smoke test:
 *   npm run cron:local
 */
async function main(): Promise<void> {
  const services = await createServices(process.env);
  console.log(`Mode: ${services.config.servicesMode} | AI: ${services.ai.id}/${services.ai.model}`);
  const result = await runAutomationTick(services, {
    trigger: 'manual',
    force: process.argv.includes('--force'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
