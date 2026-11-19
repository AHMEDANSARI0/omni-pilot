/**
 * Contract checks for the content pipeline: settings, topics, the generation-day claim, posts and the
 * draft options. Each assertion is something the app itself relies on, not a generic smoke test.
 */
import type { PostgrestDatabase } from '@/src/adapters/db/postgrest';
import { PROBE_DATE, PROBE_DATE_2, type Reporter } from './harness';

export interface ContentFixtures {
  topicId: string;
  postId: string;
}

export async function checkContent(
  db: PostgrestDatabase,
  reporter: Reporter,
): Promise<ContentFixtures> {
  const { check, expectThrows } = reporter;
  // --- settings singleton -------------------------------------------------------------------
  const settings = await db.getSettings();
  check('settings singleton readable', Boolean(settings.ownerTimezone), settings.ownerTimezone);
  const updated = await db.updateSettings({ hashtagMin: 3, hashtagMax: 6 });
  check(
    'settings update round-trips',
    updated.hashtagMax === 6,
    `hashtagMax=${updated.hashtagMax} (restored)`,
  );
  await db.updateSettings({ hashtagMax: settings.hashtagMax });

  // --- topics -------------------------------------------------------------------------------
  const topic = await db.createTopic({
    sheetRowNumber: 999_001,
    topicDate: PROBE_DATE,
    topic: 'DB contract probe topic',
    contentType: 'insight',
    keyPoints: 'a;b',
    targetAudience: 'engineers',
  });
  check('createTopic', Boolean(topic.id), topic.id);

  await expectThrows(
    'duplicate (date, topic) rejected',
    () =>
      db.createTopic({
        sheetRowNumber: 999_002,
        topicDate: PROBE_DATE,
        topic: 'DB contract probe topic',
        contentType: 'insight',
        keyPoints: null,
        targetAudience: null,
      }),
    /Duplicate record|duplicate key/i,
  );

  const second = await db.createTopic({
    sheetRowNumber: 999_003,
    topicDate: PROBE_DATE_2,
    topic: 'DB contract probe topic two',
    contentType: 'story',
    keyPoints: null,
    targetAudience: null,
  });

  const upsert = await db.upsertTopics([
    {
      sheetRowNumber: 999_001,
      topicDate: PROBE_DATE,
      topic: 'DB contract probe topic',
      contentType: 'insight',
      keyPoints: null,
      targetAudience: null,
    },
    {
      sheetRowNumber: 999_004,
      topicDate: PROBE_DATE_2,
      topic: 'DB contract probe topic two',
      contentType: 'story',
      keyPoints: null,
      targetAudience: null,
    },
  ]);
  check('upsertTopics skips existing rows', upsert.inserted === 0 && upsert.skipped === 2, JSON.stringify(upsert));

  const claimedTopic = await db.claimDailyTopic(PROBE_DATE_2, 1);
  check(
    'claimDailyTopic marks claimed + counts the attempt',
    claimedTopic?.status === 'claimed' && claimedTopic.attempts === 1,
    claimedTopic ? `${claimedTopic.status} attempts=${claimedTopic.attempts}` : 'no topic',
  );
  const secondClaim = await db.claimDailyTopic(PROBE_DATE_2, 1);
  check(
    'claimDailyTopic stops at max attempts',
    secondClaim === null,
    secondClaim ? `${secondClaim.status} attempts=${secondClaim.attempts}` : 'null',
  );
  await db.updateTopic(second.id, { status: 'skipped' });

  // --- day claim ----------------------------------------------------------------------------
  await db.updateSchedulerState({ lastGenerationStatus: 'running', generationAttempts: 0 });
  const firstClaim = await db.claimGenerationDay(PROBE_DATE, 2);
  const secondDayClaim = await db.claimGenerationDay(PROBE_DATE, 2);
  check('claimGenerationDay grants a fresh day', firstClaim, `first=${firstClaim} second=${secondDayClaim}`);
  const thirdClaim = await db.claimGenerationDay(PROBE_DATE, 2);
  check('claimGenerationDay blocks past max attempts', thirdClaim === false, `third=${thirdClaim}`);
  await db.updateSchedulerState({ lastGenerationStatus: 'succeeded' });
  const afterSuccess = await db.claimGenerationDay(PROBE_DATE, 5);
  check('claimGenerationDay blocks a finished day', afterSuccess === false, `afterSuccess=${afterSuccess}`);

  // --- posts --------------------------------------------------------------------------------
  const post = await db.createPost({
    topicId: topic.id,
    runDate: PROBE_DATE,
    hook: 'Contract probe hook',
    body: 'Body text for the contract probe.',
    hashtags: ['#probe'],
    fullText: 'Contract probe hook\n\nBody text for the contract probe.\n\n#probe',
    charCount: 60,
    provider: 'local',
    model: 'local/contract',
    status: 'pending_approval',
    source: 'ai',
  });
  check('createPost', Boolean(post.id), post.id);

  await expectThrows(
    'one post per run_date',
    () =>
      db.createPost({
        topicId: null,
        runDate: PROBE_DATE,
        hook: 'second',
        body: 'second',
        hashtags: [],
        fullText: 'second',
        charCount: 6,
        provider: 'local',
        model: 'local/contract',
        status: 'pending_approval',
        source: 'ai',
      }),
    /Duplicate record|duplicate key/i,
  );

  const variants = await db.createVariants(post.id, [
    { variantIndex: 0, angle: 'direct', hook: 'h0', body: 'b0', hashtags: [], fullText: 'h0', charCount: 2 },
    { variantIndex: 1, angle: 'story', hook: 'h1', body: 'b1', hashtags: [], fullText: 'h1', charCount: 2 },
  ]);
  check('createVariants stores every option', variants.length === 2, `n=${variants.length}`);
  const selected = await db.selectVariant(post.id, variants[1]!.id, new Date().toISOString());
  const flags = await db.listVariants(post.id);
  check(
    'selectVariant keeps exactly one selected',
    selected.variantIndex === 1 && flags.filter((v) => v.selected).length === 1,
    flags.map((v) => `${v.variantIndex}:${v.selected}`).join(' '),
  );

  return { topicId: topic.id, postId: post.id };
}
