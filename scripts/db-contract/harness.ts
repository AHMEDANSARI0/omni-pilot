/**
 * Shared plumbing for the database contract check: result collection (so a failure list can beprinted
 * at the end instead of the first throw), the "must throw" helper, and fixture cleanup.
 *
 * Fixtures live on two far-future dates and every check removes them again, so the contract check is
 * safe to run against a database that already holds real content.
 */
import type { PostgrestClient } from '@/src/adapters/db/postgrest';

export const PROBE_DATE = '2038-04-05';
export const PROBE_DATE_2 = '2038-04-06';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Reporter {
  results: CheckResult[];
  check(name: string, ok: boolean, detail: string): void;
  expectThrows(name: string, fn: () => Promise<unknown>, match: RegExp): Promise<void>;
}

export function createReporter(): Reporter {
  const results: CheckResult[] = [];
  const check: Reporter['check'] = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  // Destructured out of the object above by callers, so it must not rely on `this`.
  const expectThrows: Reporter['expectThrows'] = async (name, fn, match) => {
    try {
      await fn();
      check(name, false, 'no error thrown');
    } catch (error) {
      const message = (error as Error).message;
      check(name, match.test(message), message.slice(0, 90));
    }
  };
  return { results, check, expectThrows };
}

export async function cleanup(client: PostgrestClient): Promise<void> {
  // Children first: post_variants/approvals/jobs/whatsapp codes cascade from the post.
  await client.remove('execution_logs', { event: 'eq.db_contract_probe' }).catch(() => undefined);
  const posts = await client
    .select<Record<string, unknown>>('generated_posts', {
      select: 'id',
      run_date: `in.(${PROBE_DATE},${PROBE_DATE_2})`,
    })
    .catch(() => []);
  for (const post of posts) {
    await client.remove('generated_posts', { id: `eq.${String(post.id)}` }).catch(() => undefined);
  }
  await client
    .remove('content_topics', { topic_date: `in.(${PROBE_DATE},${PROBE_DATE_2})` })
    .catch(() => undefined);
  await client
    .remove('scheduler_state', { last_generation_date: `in.(${PROBE_DATE},${PROBE_DATE_2})` })
    .catch(() => undefined);
  // Two tables the first version of this function forgot, so every run left them behind:
  //   * `generation_claims` - the slot probes write a (probe date, slot) row that nothing else removes;
  //   * `whatsapp_messages` - the de-duplication probe records a message id.
  // A contract check that leaves rows in the owner's tables is not a contract check, it is a slow leak -
  // found by counting the tables after a run on a real database.
  await client
    .remove('generation_claims', { run_date: `in.(${PROBE_DATE},${PROBE_DATE_2})` })
    .catch(() => undefined);
  await client
    .remove('whatsapp_messages', { message_id: 'like.probe-wamid-*' })
    .catch(() => undefined);
}
