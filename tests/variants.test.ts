import { describe, expect, it } from 'vitest';
import { generateDailyPost } from '@/src/core/generation';
import { pruneDiscardedVariants, selectPostVariant } from '@/src/core/variants';
import { runAutomationTick } from '@/src/core/scheduler';
import { createHarness } from './helpers';

const angles = ['Failure story', 'Short how-to', 'Trade-off'];

function threeDrafts() {
  return angles.map((angle, index) => ({
    angle,
    hook: `Option ${index + 1}: idempotency keys stopped our duplicate agent records.`,
    body: [
      `Draft ${index + 1} explains what broke when a tool call timed out and nothing recorded that it had already run.`,
      'The change was small: store the outcome before returning, and let retries resume from the last known state instead of starting over.',
      'That removed duplicate records and turned a silent bug into a single readable log line.',
    ].join('\n\n'),
    hashtags: ['AgenticAI', 'Automation', 'Engineering'],
  }));
}

describe('draft variants', () => {
  it('stores three options from a single AI request and applies the first one', async () => {
    const harness = createHarness();
    harness.ai.responses = [threeDrafts()];

    const result = await generateDailyPost(harness.services, { trigger: 'test' });
    expect(result.status).toBe('generated');
    if (result.status !== 'generated') throw new Error('expected generated');

    // One request for three drafts - the free tier quota is spent once.
    expect(harness.ai.calls).toHaveLength(1);
    expect(result.variants).toBe(3);

    const variants = await harness.services.db.listVariants(result.post.id);
    expect(variants.map((variant) => variant.angle)).toEqual(angles);
    expect(variants.filter((variant) => variant.selected)).toHaveLength(1);
    expect(variants[0]?.selected).toBe(true);
    expect(variants[0]?.fullText).toBe(result.post.fullText);
  });

  it('swaps the post text when the owner picks another option', async () => {
    const harness = createHarness();
    harness.ai.responses = [threeDrafts()];
    const generated = await generateDailyPost(harness.services, { trigger: 'test' });
    if (generated.status !== 'generated') throw new Error('expected generated');

    const variants = await harness.services.db.listVariants(generated.post.id);
    const chosen = variants[2]!;

    const result = await selectPostVariant(harness.services, {
      postId: generated.post.id,
      variantId: chosen.id,
      actor: 'test',
    });

    expect(result.post.hook).toBe(chosen.hook);
    expect(result.post.fullText).toBe(chosen.fullText);
    expect(result.post.charCount).toBe(chosen.charCount);
    expect(result.post.source).toBe('variant');
    expect(result.post.status).toBe('pending_approval');

    const after = await harness.services.db.listVariants(generated.post.id);
    expect(after.find((variant) => variant.id === chosen.id)?.selected).toBe(true);
    expect(after.filter((variant) => variant.selected)).toHaveLength(1);
    expect(after.filter((variant) => variant.discardedAt !== null)).toHaveLength(2);

    // The approval stays usable: the token points at the post, not at the text.
    const events = await harness.services.db.listLogs({ limit: 20 });
    expect(events.some((event) => event.event === 'post.variant_selected')).toBe(true);
  });

  it('is idempotent and refuses options that are not part of the post', async () => {
    const harness = createHarness();
    harness.ai.responses = [threeDrafts()];
    const generated = await generateDailyPost(harness.services, { trigger: 'test' });
    if (generated.status !== 'generated') throw new Error('expected generated');
    const [first] = await harness.services.db.listVariants(generated.post.id);

    const again = await selectPostVariant(harness.services, {
      postId: generated.post.id,
      variantId: first!.id,
    });
    expect(again.post.fullText).toBe(generated.post.fullText);

    harness.ai.responses = [threeDrafts()];
    const other = createHarness({ sheetRows: [{ date: '2026-11-16', topic: 'Second topic' }] });
    other.ai.responses = [threeDrafts()];
    const secondRun = await generateDailyPost(other.services, { trigger: 'test' });
    if (secondRun.status !== 'generated') throw new Error('expected generated');
    const foreign = (await other.services.db.listVariants(secondRun.post.id))[1]!;

    await expect(
      selectPostVariant(harness.services, {
        postId: generated.post.id,
        variantId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to swap options after the post was approved or published', async () => {
    const harness = createHarness();
    harness.ai.responses = [threeDrafts()];
    const generated = await generateDailyPost(harness.services, { trigger: 'test' });
    if (generated.status !== 'generated') throw new Error('expected generated');
    const variants = await harness.services.db.listVariants(generated.post.id);

    await harness.services.db.updatePost(generated.post.id, { status: 'published' });

    await expect(
      selectPostVariant(harness.services, {
        postId: generated.post.id,
        variantId: variants[1]!.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('falls back to a single draft when the provider cannot produce variants', async () => {
    const harness = createHarness();
    // Simulate an older provider: only generatePost exists.
    const legacy = {
      id: 'fake-ai',
      model: 'fake-model-1',
      generatePost: (input: Parameters<typeof harness.ai.generatePost>[0]) =>
        harness.ai.generatePost(input),
    };
    harness.services.ai = legacy;

    const result = await generateDailyPost(harness.services, { trigger: 'test' });
    expect(result.status).toBe('generated');
    if (result.status !== 'generated') throw new Error('expected generated');
    expect(result.variants).toBe(1);
  });

  it('prunes discarded options after 24h, never the selected one', async () => {
    const harness = createHarness();
    harness.ai.responses = [threeDrafts()];
    const generated = await generateDailyPost(harness.services, { trigger: 'test' });
    if (generated.status !== 'generated') throw new Error('expected generated');
    const variants = await harness.services.db.listVariants(generated.post.id);

    await selectPostVariant(harness.services, {
      postId: generated.post.id,
      variantId: variants[1]!.id,
    });

    expect(await pruneDiscardedVariants(harness.services)).toBe(0);

    harness.clock.advanceMinutes(25 * 60);
    expect(await pruneDiscardedVariants(harness.services)).toBe(2);

    const left = await harness.services.db.listVariants(generated.post.id);
    expect(left).toHaveLength(1);
    expect(left[0]?.selected).toBe(true);
  });

  it('runs the prune inside the automation tick without failing the tick', async () => {
    const harness = createHarness({ now: '2026-11-16T04:00:00Z' });
    const result = await runAutomationTick(harness.services, { trigger: 'cron' });
    expect(result.errors).toEqual([]);
    expect(result.prunedVariants).toBe(0);
  });
});
