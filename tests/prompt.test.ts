import { describe, expect, it } from 'vitest';
import { buildGenerationPrompt, buildVariantsPrompt } from '@/src/core/prompt';
import type { GeneratePostInput } from '@/src/core/ports';

/**
 * The prompt is the product: a wrong instruction here is a wrong post, and it is the one place where a
 * model sees the owner's real material. These tests pin the rules the prompt must always carry, so a
 * refactor cannot quietly drop "never invent facts" or the character budget.
 */
function input(overrides: Partial<GeneratePostInput> = {}): GeneratePostInput {
  return {
    topic: 'Idempotency keys for agent tool calls',
    contentType: 'insight',
    keyPoints: 'A retry created a duplicate record. Keys are hashed on tool+args.',
    targetAudience: 'engineers building agents',
    brandVoice: 'Direct, specific, no hype.',
    writingInstructions: 'Short paragraphs. No emoji.',
    hashtagMin: 3,
    hashtagMax: 5,
    maxChars: 2800,
    recentHooks: ['Most agent workflows fail on the boring part.'],
    ...overrides,
  };
}

describe('buildGenerationPrompt', () => {
  it('carries the topic, type, audience and source material', () => {
    const { prompt } = buildGenerationPrompt(input());
    expect(prompt).toContain('TOPIC: Idempotency keys for agent tool calls');
    expect(prompt).toContain('CONTENT TYPE: insight');
    expect(prompt).toContain('TARGET AUDIENCE: engineers building agents');
    expect(prompt).toContain('A retry created a duplicate record.');
  });

  it('tells the model to stay honest when no material is supplied', () => {
    const { prompt } = buildGenerationPrompt(input({ keyPoints: null, targetAudience: null }));
    expect(prompt).toContain('never invent facts');
    expect(prompt).toContain('stay general and honest');
    expect(prompt).toContain('engineers, technical founders and automation leads');
  });

  it('derives the character budget from maxChars', () => {
    expect(buildGenerationPrompt(input({ maxChars: 2800 })).prompt).toContain('under 2680 characters');
    // A tiny setting must not produce a budget the model cannot satisfy.
    expect(buildGenerationPrompt(input({ maxChars: 400 })).prompt).toContain('under 300 characters');
  });

  it('lists recent hooks so they are not reused, and says so when there are none', () => {
    expect(buildGenerationPrompt(input()).prompt).toContain(
      '- Most agent workflows fail on the boring part.',
    );
    expect(buildGenerationPrompt(input({ recentHooks: [] })).prompt).toContain('- (none yet)');
  });

  it('adds the hook-library block only when there is one', () => {
    const withLibrary = buildGenerationPrompt(
      input({ hookLibrary: 'OPENINGS THAT WORKED:\n- "I deleted 400 lines"' }),
    ).prompt;
    expect(withLibrary).toContain('OPENINGS THAT WORKED');
    expect(withLibrary).toContain('I deleted 400 lines');

    // Whitespace-only library must not create an empty section.
    const blank = buildGenerationPrompt(input({ hookLibrary: '   \n  ' })).prompt;
    expect(blank).not.toContain('OPENINGS THAT WORKED');
    expect(blank).not.toMatch(/\n\n\n\n/);
  });

  it('keeps the honesty and formatting rules in the system instruction', () => {
    const { systemInstruction } = buildGenerationPrompt(input());
    expect(systemInstruction).toContain('never invent achievements, employers, clients');
    expect(systemInstruction).toContain('JSON only');
    expect(systemInstruction).toContain('"hook" is 1-2 sentences (max 220 characters)');
    expect(systemInstruction).toContain('No bullet characters');
  });
});

describe('buildVariantsPrompt', () => {
  it('asks for the requested number of clearly different options', () => {
    const { prompt } = buildVariantsPrompt(input(), 3);
    expect(prompt).toContain('write 3 clearly different options');
    expect(prompt).toContain('Do not repeat a hook or an opening line between options.');
    expect(prompt).toContain('"variants"');
    expect(prompt).toContain('"angle" is a label of 1-4 words');
  });

  it('keeps the single-post rules (honesty, budget, hashtags) inherited', () => {
    const { prompt } = buildVariantsPrompt(input(), 2);
    expect(prompt).toContain('never invent facts');
    expect(prompt).toContain('under 2680 characters');
    expect(prompt).toContain('3-5 hashtags');
    expect(prompt).toContain('Every option must stay honest');
  });

  it('uses the same system instruction as the single-post path', () => {
    const single = buildGenerationPrompt(input());
    const variants = buildVariantsPrompt(input(), 3);
    expect(variants.systemInstruction).toBe(single.systemInstruction);
  });
});
