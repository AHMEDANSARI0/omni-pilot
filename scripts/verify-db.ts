/**
 * Verify a real Supabase project against the expected schema and RPC functions.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run db:verify
 *
 * Not quite read-only: `claim_generation_day` and `claim_generation_slot` write by design, so their 1990
 * probe rows are snapshotted first and restored at the end (the run prints one line when it does that).
 * Safe to run against a live project.
 *
 * A wrong key stops it immediately, with one explanation instead of thirty-one permission errors: this
 * script is also how you find out that `SUPABASE_SERVICE_ROLE_KEY` holds the anon key.
 */
import { PostgrestClient, PostgrestDatabase } from '@/src/adapters/db/postgrest';
import { describeKey, requireSupabase } from './lib/env';

const TABLES = [
  'app_settings',
  'content_topics',
  'generated_posts',
  'approval_requests',
  'publishing_jobs',
  'integrations',
  'oauth_states',
  'execution_logs',
  'scheduler_state',
  'whatsapp_approval_codes',
  'whatsapp_messages',
  'post_variants',
  // Phase 10
  'generation_claims',
  'api_keys',
  'api_requests',
  'webhook_endpoints',
  'webhook_deliveries',
  'push_subscriptions',
] as const;

const RPCS = [
  'claim_daily_topic',
  'claim_publishing_jobs',
  'consume_approval',
  'expire_stale_approvals',
  'claim_generation_day',
  'claim_post_for_publish',
  'recover_stuck_jobs',
  'prune_whatsapp_artifacts',
  // Phase 10 - per-slot claims and the webhook runner
  'claim_generation_slot',
  'finish_generation_slot',
  'claim_webhook_deliveries',
  // Phase 10 hardening: a delivery a dead worker claimed goes back to the queue.
  'recover_webhook_deliveries',
] as const;


async function main(): Promise<void> {
  // Reads .env.local when the variables are not already set, and refuses a key that cannot work.
  const { url, key } = requireSupabase();

  const client = new PostgrestClient({ url, serviceRoleKey: key });
  const db = new PostgrestDatabase(client);
  const failures: string[] = [];

  console.log(`Checking Supabase project ${url}`);
  console.log(`Key role: ${describeKey(key).role}\n`);


  for (const table of TABLES) {
    try {
      await client.select(table, { select: '*', limit: '1' });
      console.log(`  ok   table ${table}`);
    } catch (error) {
      failures.push(`table ${table}: ${(error as Error).message}`);
      console.log(`  FAIL table ${table}`);
    }
  }

  // Two probes below are statements, not questions: `claim_generation_day` and `claim_generation_slot`
  // write to `scheduler_state` and `generation_claims` by design (they are claim functions - that is what
  // they do). On the first real run this left `last generation: 1990-01-01` in the scheduler row, which is
  // exactly the kind of junk a verification script must never leave behind: it looks like real history in
  // the settings screen. So the rows are snapshotted here and put back at the end.
  const probeRows: { table: string; filters: Record<string, string>; rows: Record<string, unknown>[] }[] = [];
  const snapshot = async (table: string, filters: Record<string, string>): Promise<void> => {
    try {
      probeRows.push({ table, filters, rows: await client.select(table, { ...filters, select: '*' }) });
    } catch {
      probeRows.push({ table, filters, rows: [] });
    }
  };
  await snapshot('scheduler_state', { id: 'eq.true' });
  await snapshot('generation_claims', { run_date: 'eq.1990-01-01' });
  // Whether the row is ours to delete at the end, or the owner's to keep. The probes create it if it is
  // missing (`claim_generation_day` inserts on conflict do nothing), so "no row now" means "delete it after".
  const schedulerRowExisted =
    (probeRows.find((entry) => entry.table === 'scheduler_state')?.rows.length ?? 0) > 0;

  console.log('');
  for (const fn of RPCS) {
    try {
      switch (fn) {
        case 'claim_daily_topic':
          await client.rpc(fn, { p_date: '1990-01-01', p_max_attempts: 1 });
          break;
        case 'claim_publishing_jobs':
          await client.rpc(fn, { p_limit: 1 });
          break;
        case 'consume_approval':
          await client.rpc(fn, { p_token_hash: 'verify-only', p_action: 'approve' });
          break;
        case 'claim_generation_day':
          // Read-only probe: uses a date in the past that will never be claimed again.
          await client.rpc(fn, { p_date: '1990-01-01', p_max_attempts: 0 });
          break;
        case 'claim_post_for_publish':
          await client.rpc(fn, { p_post_id: '00000000-0000-0000-0000-000000000000' });
          break;
        // Phase 10 - probed with a 1990 date and slot 0, so nothing real is ever claimed.
        case 'claim_generation_slot':
          await client.rpc(fn, { p_date: '1990-01-01', p_slot: 0, p_max_attempts: 0 });
          break;
        case 'finish_generation_slot':
          await client.rpc(fn, { p_date: '1990-01-01', p_slot: 0, p_status: 'failed' });
          break;
        case 'claim_webhook_deliveries':
          await client.rpc(fn, { p_limit: 0 });
          break;
        // Read-only in practice: nothing is stranded, so it returns 0.
        case 'recover_webhook_deliveries':
          await client.rpc(fn, { p_max_attempts: 5 });
          break;
        default:
          await client.rpc(fn, {});
      }
      console.log(`  ok   rpc   ${fn}`);
    } catch (error) {
      failures.push(`rpc ${fn}: ${(error as Error).message}`);
      console.log(`  FAIL rpc   ${fn}`);
    }
  }

  console.log('');
  try {
    const settings = await db.getSettings();
    console.log(`  ok   settings singleton (timezone ${settings.ownerTimezone})`);
  } catch (error) {
    failures.push(`settings: ${(error as Error).message}`);
  }
  // Put back what the probes wrote, BEFORE anything reports on that state. The earlier order printed
  // `last generation: 1990-01-01` - true at that instant, meaningless to read, and alarming in a report.
  // This order prints the value the database actually holds.
  //
  // Restoring is not simply "delete the probe date and reset the row", because both have a legitimate
  // other case: a 1990 claim may be real data, and on a fresh project there was no scheduler row at all
  // before the probe created one.
  try {
    const originalClaims = probeRows.find((entry) => entry.table === 'generation_claims')?.rows ?? [];
    const nowClaims = await client.select('generation_claims', { run_date: 'eq.1990-01-01', select: '*' });
    const touchedSlots = new Set(nowClaims.map((row) => String(row.slot_index)));
    for (const row of originalClaims) touchedSlots.delete(String(row.slot_index));
    // Slots the probes created: remove them. Slots that were already there: restore their columns.
    for (const slot of touchedSlots) {
      await client.remove('generation_claims', { run_date: 'eq.1990-01-01', slot_index: `eq.${slot}` });
    }
    for (const row of originalClaims) {
      await client.update(
        'generation_claims',
        { run_date: 'eq.1990-01-01', slot_index: `eq.${row.slot_index}` },
        { status: row.status, attempts: row.attempts, claimed_at: row.claimed_at, updated_at: row.updated_at },
      );
    }

    const original = probeRows.find((entry) => entry.table === 'scheduler_state');
    const row = original?.rows[0];
    if (!schedulerRowExisted) {
      // The probe created this row; leaving it would report a date nothing was generated on.
      await client.remove('scheduler_state', { id: 'eq.true' });
    } else if (row) {
      const patch = {
        last_generation_date: row.last_generation_date ?? null,
        last_generation_at: row.last_generation_at ?? null,
        last_generation_status: row.last_generation_status ?? null,
        generation_attempts: row.generation_attempts ?? 0,
      };
      await client.update('scheduler_state', { id: 'eq.true' }, patch);
    }
    console.log(
      `  ok   probe rows cleaned up (${
        schedulerRowExisted ? 'scheduler_state restored' : 'scheduler row removed - it did not exist before'
      }, ${touchedSlots.size} probe claim(s) deleted, ${originalClaims.length} restored)`,
    );
  } catch (error) {
    failures.push(`cleanup: ${(error as Error).message} - the 1990 probe rows may still be in the database`);
  }

  try {
    const state = await db.getSchedulerState();
    console.log(`  ok   scheduler state (last generation: ${state.lastGenerationDate ?? 'never'})`);
  } catch (error) {
    failures.push(`scheduler_state: ${(error as Error).message}`);
  }

  console.log('');
  if (failures.length > 0) {
    // Permission denials are one problem wearing twenty-six hats: either the key is the wrong role, or the
    // grants never landed. Say which, once, instead of printing the wall.
    const denied = failures.filter((f) => f.includes('permission denied'));
    const rest = failures.filter((f) => !f.includes('permission denied'));
    console.error(`Verification failed with ${failures.length} problem(s):`);
    if (denied.length > 0) {
      console.error(
        `\n  ${denied.length} x permission denied - all one cause. Either the key above is not service_role,\n` +
          '  or the grants did not land. Fix: run supabase/setup.sql once in the SQL Editor (it re-asserts\n' +
          '  every grant from the catalogue, so it repairs a half-migrated database).',
      );
    }
    for (const failure of rest) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    'Database verification passed. Apply 0001_schema.sql and 0002_functions.sql if anything was missing.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
