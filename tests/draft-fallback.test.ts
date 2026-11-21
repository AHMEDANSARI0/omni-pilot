import { describe, expect, it } from 'vitest';
import { createHarness } from './helpers';
import { generateDraftOptions } from '@/src/core/variants';
import { createLogger } from '@/src/core/logger';
import type { Post, Topic } from '@/src/core/types';

/**
 * The retry has to actually be a different draft.
 *
 * `e2e/safety.spec.ts:126` failed with `Expected: "generated", Received: "failed"` on a run with no slot. The
 * guard dropped every draft as a repeat of an earlier post, the attempt was retried with the reasons spelled
 * out in `writingInstructions` - and the local provider, which has no model behind it, ignored that instruction
 * and answered with the same three drafts. Every option was rejected again and generation threw.
 *
 * Phase 7 deliberately fails a run rather than publishing a repeat (`tests/generation.test.ts:240` pins it,
 * and it is the right product behaviour), so the fix belongs in the provider: a retry must produce text the
 * first attempt did not. These two tests hold both halves of that.
 */
const REPEATED = {
  hook: 'Most agent workflows fail on the boring part: idempotency keys',
  body: 'Retries without an idempotency key duplicate side effects. That was the bug that cost us a day.',
  hashtags: ['AgenticAI', 'AIAutomation', 'Engineering'],
};

const RECENT: Post[] = [
  {
    id: 'post-1',
    runDate: '2031-03-01',
    slotIndex: 0,
    hook: REPEATED.hook,
    body: REPEATED.body,
    hashtags: REPEATED.hashtags,
    fullText: 'text',
    charCount: 4,
    provider: 'test',
    status: 'published',
  } as unknown as Post,
];

const TOPIC = {
  id: 'topic-1',
  topicDate: '2033-01-01',
  slotIndex: 0,
  topic: 'Single use approval link',
  contentType: 'insight',
  keyPoints: null,
  targetAudience: null,
  status: 'pending',
  attempts: 0,
  lastError: null,
  sheetRowNumber: null,
  createdAt: '2026-11-16T03:00:00.000Z',
  updatedAt: '2026-11-16T03:00:00.000Z',
} as unknown as Topic;

describe('the local provider answers a retry with different text', () => {
  it('picks sentences it has not already offered', async () => {
    const { LocalAiProvider } = await import('@/src/adapters/ai/local');
    const provider = new LocalAiProvider();
    const base = {
      topic: 'Single use approval link',
      contentType: 'insight' as const,
      keyPoints: null,
      targetAudience: null,
      brandVoice: 'plain',
      writingInstructions: 'Be useful.',
      hashtagMin: 3,
      hashtagMax: 5,
      maxChars: 2800,
      slotIndex: 0,
      recentHooks: [],
      hookLibrary: '',
    };

    const first = await provider.generateVariants({ ...base }, 3);
    const retry = await provider.generateVariants(
      {
        ...base,
        writingInstructions:
          'Be useful.\n\nThe previous drafts had these problems - fix all of them: Repeats earlier work: The opening repeats a post from 2031-03-01 (100% similar)',
      },
      3,
    );

    // There are four angle sets and three drafts per attempt, so a retry can never be entirely disjoint from
    // the first attempt - that is arithmetic, not a bug. What must hold is the thing the pipeline depends on:
    // the draft it picks first (option 0) is not the draft that was just rejected, so the retry has something
    // new to offer. Before this fix the retry returned all three of the refused drafts, verbatim, twice.
    expect(first.length).toBeGreaterThan(0);
    expect(`${retry[0]!.hook}\n\n${retry[0]!.body}`).not.toBe(`${first[0]!.hook}\n\n${first[0]!.body}`);
    expect(retry[0]!.hook).not.toBe(first[0]!.hook);
  });

  it('never lets a repeat reach the queue - the run fails loudly instead (Phase 7)', async () => {
    const harness = createHarness({ now: '2026-11-16T03:05:00Z' });
    const settings = await harness.services.db.getSettings();
    // The fake provider ignores the retry instruction, so every option is a repeat: this must throw, and it
    // must not quietly publish. That is why the fix above belongs in the provider, not in the guard.
    harness.ai.responses = [REPEATED, REPEATED, REPEATED, REPEATED, REPEATED, REPEATED];
    await expect(
      generateDraftOptions(
        harness.services,
        settings,
        TOPIC,
        RECENT,
        createLogger(harness.services.db, { actor: 'test' }),
      ),
    ).rejects.toThrow(/Repeats earlier work/);
  });
});
