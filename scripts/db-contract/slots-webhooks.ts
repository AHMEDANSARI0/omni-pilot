/**
 * Behavioural contract for the Phase 10 objects: slots, generation claims and the webhook queue.
 *
 * `db:verify` only asks "does this table exist". These assertions drive the real schema and fail if a
 * migration and the code ever disagree about behaviour - the things that are impossible to prove with a
 * unit test because the truth lives in SQL:
 *
 *   - two slots of one day can each be claimed once, and a third claim of the same slot is refused
 *   - a post may exist once per (day, slot), and a second insert for the same pair is rejected
 *   - `claim_webhook_deliveries` hands a row out exactly once, and only when it is due
 *   - a delivery that is retried moves `next_attempt_at` forward instead of staying claimable
 *
 * Every row it creates uses the probe dates and is removed by `cleanup`, so this is safe to run against a
 * database with real content in it.
 */
import type { PostgrestClient, PostgrestDatabase } from '@/src/adapters/db/postgrest';
import type { Reporter } from './harness';
import { PROBE_DATE, PROBE_DATE_2 } from './harness';

export async function checkSlotsAndWebhooks(
  db: PostgrestDatabase,
  client: PostgrestClient,
  reporter: Reporter,
): Promise<void> {
  const { check } = reporter;

  /* ------------------------------------------------------------ generation claims */

  // `claim_generation_slot` is the per-(day, slot) claim. Two slots of the same day must both be claimable,
  // and the same slot twice must not be - that pair is what stops two ticks writing two drafts.
  const slot0First = await db.claimGenerationSlot(PROBE_DATE, 0, 3);
  check('claim_generation_slot claims slot 0', slot0First === true, String(slot0First));

  const slot1 = await db.claimGenerationSlot(PROBE_DATE, 1, 3);
  check('a second slot of the same day is independently claimable', slot1 === true, String(slot1));

  // The claim is per (date, slot) and the attempt counter is shared by that pair: a slot that already
  // succeeded must not be re-claimable, and one that failed must be (up to the attempt limit).
  await db.finishGenerationSlot(PROBE_DATE, 1, 'succeeded');
  await db.finishGenerationSlot(PROBE_DATE, 0, 'failed');
  const succeededAgain = await db.claimGenerationSlot(PROBE_DATE, 1, 3);
  check('a slot that succeeded is not claimable again', succeededAgain === false, String(succeededAgain));
  const failedAgain = await db.claimGenerationSlot(PROBE_DATE, 0, 3);
  check('a slot that failed can be claimed again', failedAgain === true, String(failedAgain));

  /* ---------------------------------------------------------- one post per (day, slot) */

  const topic = await db.createTopic({
    sheetRowNumber: null,
    topicDate: PROBE_DATE_2,
    slotIndex: 0,
    topic: 'contract probe: slot uniqueness',
    contentType: 'text',
    keyPoints: null,
    targetAudience: null,
  });


  const basePost = {
    topicId: topic.id,
    runDate: PROBE_DATE_2,
    slotIndex: 0,
    hook: 'probe',
    body: 'contract probe body',
    hashtags: [],
    fullText: 'probe',
    charCount: 5,
    provider: 'contract',
    model: 'contract',
    status: 'pending_approval' as const,
    source: 'contract probe',
  };
  const first = await db.createPost(basePost);
  check('a post is accepted for (date, slot 0)', Boolean(first.id), first.id);

  // The unique index is `(run_date, slot_index)`. A second insert for the same pair must be refused by SQL,
  // not by application code - `createPost` has no such guard, which is the point of testing it here.
  let duplicateRefused = false;
  try {
    await db.createPost({ ...basePost, slotIndex: 0 });
  } catch {
    duplicateRefused = true;
  }
  check('the database refuses a second post for the same (date, slot)', duplicateRefused, 'unique index');

  const secondSlot = await db.createPost({ ...basePost, slotIndex: 1 }).catch(() => null);
  check('a second slot of the same day is a different post', secondSlot !== null, secondSlot ? 'inserted' : 'refused');

  /* ------------------------------------------------------------------ webhook queue */

  const endpoint = await db.createWebhookEndpoint({
    name: 'contract probe',
    url: 'https://omni.test/contract-probe',
    secret: 'whsec_contract_probe',
    events: ['*'],
  });

  const queued = await db.enqueueWebhookDelivery({
    endpointId: endpoint.id,
    event: 'post.published',
    eventId: `${PROBE_DATE}:contract-probe`,
    payload: { probe: true },
    nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
  });
  check('a due delivery is queued', queued === true, String(queued));

  // `enqueueWebhookDelivery` returns false for a repeated event id - that is what makes a retried tick safe.
  const again = await db.enqueueWebhookDelivery({
    endpointId: endpoint.id,
    event: 'post.published',
    eventId: `${PROBE_DATE}:contract-probe`,
    payload: { probe: true },
    nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
  });
  check('the same event id is not queued twice', again === false, String(again));

  const claimed = await db.claimWebhookDeliveries(10);
  const mine = claimed.filter((row) => row.endpointId === endpoint.id);
  check('claim_webhook_deliveries hands out the due row exactly once', mine.length === 1, `${mine.length}`);
  check('a claimed delivery is marked delivering', mine[0]?.status === 'delivering', mine[0]?.status ?? 'none');

  const claimedAgain = await db.claimWebhookDeliveries(10);
  const rehanded = claimedAgain.filter((row) => row.endpointId === endpoint.id).length;
  check('a row that is already delivering is not handed out again', rehanded === 0, String(rehanded));

  // A retry is only claimable once `next_attempt_at` says so - that is what keeps the every-minute cron
  // from hammering an endpoint that just failed.
  await db.updateWebhookDelivery(mine[0]!.id, {
    status: 'pending',
    attempts: 1,
    nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    responseStatus: 500,
    responseBody: 'probe failure',
    deliveredAt: null,
  });
  const notYet = await db.claimWebhookDeliveries(10);
  const early = notYet.filter((row) => row.endpointId === endpoint.id).length;
  check('a delivery backed off into the future is not claimed', early === 0, String(early));

  const log = await db.listWebhookDeliveries({ endpointId: endpoint.id });
  check('the delivery log keeps the failed attempt', log[0]?.attempts === 1, String(log[0]?.attempts));

  /* ------------------------------------------------- abandoned claims (0006) */

  // A worker claims a delivery and then dies. The row is `delivering`, `claim_webhook_deliveries` only reads
  // `pending`, and nothing reports it - so before 0006 that event was lost for ever. The contract proves the
  // recovery function actually moves it, because this is behaviour only the database can provide.
  const stranded = await db.enqueueWebhookDelivery({
    endpointId: endpoint.id,
    event: 'post.published',
    eventId: `${PROBE_DATE}:stranded-probe`,
    payload: { probe: 'stranded' },
    nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
  });
  check('a delivery can be queued for the abandoned-claim probe', stranded === true, String(stranded));
  const claimedStranded = (await db.claimWebhookDeliveries(10)).filter(
    (row) => row.endpointId === endpoint.id,
  );
  check('it is claimed (and now sits in delivering)', claimedStranded.length === 1, `${claimedStranded.length}`);

  // Age the claim instead of waiting five minutes: the function decides on `updated_at`, which the trigger keeps
  // current, so the probe sets it directly.
  await client.update(
    'webhook_deliveries',
    { id: `eq.${claimedStranded[0]!.id}` },
    { updated_at: new Date(Date.now() - 6 * 60_000).toISOString() },
  );
  const recovered = await db.recoverWebhookDeliveries(5);
  check('recover_webhook_deliveries returns abandoned claims to the queue', recovered >= 1, `${recovered}`);
  const rehandedStranded = (await db.claimWebhookDeliveries(10)).filter(
    (row) => row.eventId === `${PROBE_DATE}:stranded-probe`,
  );
  check(
    'the recovered delivery is claimable again',
    rehandedStranded.length === 1,
    `${rehandedStranded.length}`,
  );

  // Removing the endpoint cascades its deliveries, which is what `cleanup` relies on. Proving it here means
  // a change to that constraint is caught now rather than as a mysterious leftover row.
  await client.remove('webhook_endpoints', { id: `eq.${endpoint.id}` });
  const afterDelete = await db.listWebhookDeliveries({ endpointId: endpoint.id });
  check('deleting an endpoint removes its deliveries', afterDelete.length === 0, `${afterDelete.length}`);
}
