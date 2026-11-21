/**
 * Live schema + contract check.
 *
 * `npm run db:verify` only asks "does this object exist". This goes further: it drives the real
 * `PostgrestDatabase` adapter against a real PostgREST endpoint and asserts the behaviour the app
 * relies on (single-use approvals, the day claim, one post per day, locked jobs, idempotent WhatsApp
 * handling, and - since Phase 10 - per-slot claims, one post per (day, slot) and the webhook queue).
 * If a migration and the adapter ever drift apart, this fails.
 *
 *   Database contract (needs a running Supabase project or the local stack):
 *     SUPABASE_URL=https://xyz.supabase.co SUPABASE_SERVICE_ROLE_KEY=... npm run db:contract
 *
 *   Local stack without a Supabase account (Postgres + PostgREST in Docker):
 *     npm run db:local      # schema + functions + contract, then cleans its own fixtures
 *
 * Fixtures use a far-future date and are removed at the end, so this can be run against a database
 * that already has real content. The checks live in scripts/db-contract/.
 */
import { PostgrestClient, PostgrestDatabase } from '@/src/adapters/db/postgrest';
import { checkContent } from './db-contract/content';
import { cleanup, createReporter, PROBE_DATE } from './db-contract/harness';
import { checkPipeline } from './db-contract/pipeline';
import { checkSlotsAndWebhooks } from './db-contract/slots-webhooks';
import { requireSupabase } from './lib/env';

// `npm run db:contract` is also a bare `tsx` call, so the keys in .env.local have to be read in code -
// this script used to skip that and print "keys are required" while they were sitting in the file.
const { url, key } = requireSupabase();

const client = new PostgrestClient({ url, serviceRoleKey: key });
const db = PostgrestDatabase.create({ url, serviceRoleKey: key });

async function main(): Promise<void> {
  console.log(`Database contract check against ${url}\n`);
  const reporter = createReporter();
  await cleanup(client);

  const fixtures = await checkContent(db, reporter);
  await checkPipeline(db, client, reporter, fixtures);
  // Phase 10 behaviour: per-slot claims, one post per (day, slot), and the webhook queue.
  await checkSlotsAndWebhooks(db, client, reporter);
  await cleanup(client);
  await client
    .remove('integrations', { provider: 'eq.gemini', account_label: 'eq.contract probe' })
    .catch(() => undefined);

  const failures = reporter.results.filter((result) => !result.ok);
  console.log('');
  if (failures.length > 0) {
    console.error(`Contract check failed with ${failures.length} problem(s):`);
    for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail}`);
    process.exit(1);
  }
  console.log(`Contract check passed (${reporter.results.length} assertions) on ${PROBE_DATE} fixtures.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
