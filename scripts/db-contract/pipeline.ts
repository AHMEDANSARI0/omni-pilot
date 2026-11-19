/**
 * Contract checks for the delivery side: approvals (single use), publishing jobs (locks, one job per
 * post), integrations, the audit log, OAuth state replay and the WhatsApp single-use paths.
 */
import { PostgrestClient, type PostgrestDatabase } from '@/src/adapters/db/postgrest';
import type { Reporter } from './harness';

export async function checkPipeline(
  db: PostgrestDatabase,
  client: PostgrestClient,
  reporter: Reporter,
  fixtures: { postId: string; topicId: string },
): Promise<void> {
  const { check, expectThrows } = reporter;
  const post = { id: fixtures.postId };
  // --- approvals ----------------------------------------------------------------------------
  const tokenHash = `probe-${Date.now()}`;
  const approval = await db.createApproval({
    postId: post.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  check('createApproval', approval.status === 'pending', approval.status);
  const active = await db.getActiveApprovalForPost(post.id);
  check('getActiveApprovalForPost', active?.id === approval.id, active?.id ?? 'none');
  const consumed = await db.consumeApproval(tokenHash, 'approve');
  check('consumeApproval approves', consumed?.status === 'approved', consumed?.status ?? 'null');
  const replayed = await db.consumeApproval(tokenHash, 'approve');
  check('consumeApproval is single use', replayed === null, replayed ? 'returned a row' : 'null');

  const expiredHash = `probe-expired-${Date.now()}`;
  await db.createApproval({
    postId: post.id,
    tokenHash: expiredHash,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const expiredConsume = await db.consumeApproval(expiredHash, 'approve');
  check('consumeApproval refuses an expired token', expiredConsume === null, expiredConsume ? 'row' : 'null');

  await expectThrows(
    'consume_approval rejects an invalid action',
    () => client.rpc('consume_approval', { p_token_hash: 'x', p_action: 'maybe' }),
    /invalid action|22023/i,
  );

  // --- jobs ---------------------------------------------------------------------------------
  const job = await db.createJob({ postId: post.id, runAt: new Date(Date.now() - 60_000).toISOString() });
  check('createJob', job.status === 'queued', job.status);
  const jobAgain = await db.createJob({ postId: post.id, runAt: new Date(Date.now() + 60_000).toISOString() });
  check('one job per post (upsert)', jobAgain.id === job.id, jobAgain.id === job.id ? 'same row' : 'new row');

  const notApproved = await db.claimPostForPublish(post.id);
  check(
    'claimPostForPublish needs an approved post',
    notApproved === null,
    notApproved ? `claimed ${notApproved.status}` : 'null (post is pending_approval)',
  );

  // The upsert above moved run_at into the future; make the job due again before claiming.
  await db.createJob({ postId: post.id, runAt: new Date(Date.now() - 60_000).toISOString() });
  const due = await db.claimDueJobs(5);
  const mine = due.find((candidate) => candidate.id === job.id);
  check(
    'claimDueJobs locks the job for 10 minutes',
    Boolean(mine?.lockedUntil) && mine?.status === 'processing',
    mine ? `${mine.status} locked=${mine.lockedUntil}` : 'job not claimed',
  );
  const dueAgain = await db.claimDueJobs(5);
  check(
    'claimDueJobs does not hand out a locked job',
    !dueAgain.some((candidate) => candidate.id === job.id),
    `n=${dueAgain.length}`,
  );

  await db.updateJob(job.id, {
    status: 'published',
    postUrl: 'https://example.com/probe',
    publishedAt: new Date().toISOString(),
  });
  const sweep = await db.expireStaleApprovals();
  check(
    'expireStaleApprovals returns both counts',
    typeof sweep.expiredApprovals === 'number' && typeof sweep.expiredPosts === 'number',
    JSON.stringify(sweep),
  );
  const recovered = await db.recoverStuckJobs();
  check('recoverStuckJobs returns a number', typeof recovered === 'number', String(recovered));

  // --- integrations, logs, oauth, whatsapp ---------------------------------------------------
  const integration = await db.upsertIntegration('gemini', {
    status: 'connected',
    accountLabel: 'contract probe',
    scopes: ['generate'],
    metadata: { probe: true },
  });
  check('upsertIntegration', integration.provider === 'gemini', `${integration.status} ${integration.accountLabel}`);
  await db.insertLog({
    level: 'info',
    event: 'db_contract_probe',
    message: 'contract check',
    context: { probe: true },
    actor: 'db-contract',
  });
  const logs = await db.listLogs({ event: 'db_contract_probe', limit: 5 });
  check('insertLog/listLogs round-trip', logs.length >= 1, `n=${logs.length}`);

  const state = `probe-state-${Date.now()}`;
  await db.createOAuthState({
    state,
    provider: 'linkedin',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    redirectAfter: '/settings',
  });
  const stateOnce = await db.consumeOAuthState(state);
  const stateTwice = await db.consumeOAuthState(state);
  check('consumeOAuthState is single use', Boolean(stateOnce) && stateTwice === null, `${Boolean(stateOnce)} / ${stateTwice}`);

  const codeHash = `probe-code-${Date.now()}`;
  await db.createWhatsAppCode({
    codeHash,
    postId: post.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const codeOnce = await db.consumeWhatsAppCode(codeHash);
  const codeTwice = await db.consumeWhatsAppCode(codeHash);
  check('consumeWhatsAppCode is single use', codeOnce !== null && codeTwice === null, `${Boolean(codeOnce)} / ${codeTwice}`);

  const messageId = `probe-wamid-${Date.now()}`;
  const firstMessage = await db.recordWhatsAppMessage({
    messageId,
    from: '920000000000',
    receivedAt: new Date().toISOString(),
  });
  const secondMessage = await db.recordWhatsAppMessage({
    messageId,
    from: '920000000000',
    receivedAt: new Date().toISOString(),
  });
  check('recordWhatsAppMessage de-duplicates', firstMessage && !secondMessage, `${firstMessage} / ${secondMessage}`);

}