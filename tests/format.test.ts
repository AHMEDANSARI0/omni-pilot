import { describe, expect, it } from 'vitest';
import {
  composePost,
  countChars,
  extractInlineHashtags,
  hardIssues,
  normalizeHashtag,
  normalizeHashtags,
  splitPostText,
  validateDraft,
} from '@/src/core/format';

const options = { maxChars: 2800, hashtagMin: 3, hashtagMax: 5 };

const goodDraft = {
  hook: 'Retries were creating duplicate records in every agent workflow we shipped.',
  body: [
    'The model call was never the problem. The problem was that a timeout meant we did not know whether the tool had already run.',
    'We gave every tool call an idempotency key, stored the result before returning, and made the retry path read that record first.',
    'It is boring engineering, but it is the difference between an agent that behaves and one that leaves a mess behind.',
  ].join('\n\n'),
  hashtags: ['AgenticAI', 'AIAutomation', 'Engineering'],
};

describe('hashtag handling', () => {
  it('normalises spacing, casing and stray characters', () => {
    expect(normalizeHashtag('#agentic ai')).toBe('#AgenticAi');
    expect(normalizeHashtag('api integrations')).toBe('#ApiIntegrations');
    expect(normalizeHashtag('  #Python!  ')).toBe('#Python');
    expect(normalizeHashtag('###')).toBeNull();
  });

  it('deduplicates case-insensitively and respects the maximum', () => {
    const result = normalizeHashtags(
      ['ai', 'AI', 'Automation', 'python', 'apis', 'extra', 'more'],
      { ...options, hashtagMax: 4 },
    );
    expect(result).toEqual(['#Ai', '#Automation', '#Python', '#Apis']);
  });

  it('extracts inline hashtags', () => {
    expect(extractInlineHashtags('text #One #Two more')).toEqual(['One', 'Two']);
  });
});

describe('post composition', () => {
  it('joins hook, body and hashtags with blank lines', () => {
    const text = composePost('Hook here.', 'Body here.', ['#A', '#B']);
    expect(text).toBe('Hook here.\n\nBody here.\n\n#A #B');
  });

  it('round-trips free-form text back into parts', () => {
    const text = composePost(goodDraft.hook, goodDraft.body, ['#AgenticAI', '#Python']);
    const split = splitPostText(text);
    expect(split.hook).toBe(goodDraft.hook);
    expect(split.body).toBe(goodDraft.body);
    expect(split.hashtags).toEqual(['AgenticAI', 'Python']);
  });

  it('counts unicode characters the way LinkedIn does', () => {
    expect(countChars('héllo 👋')).toBe(7);
  });
});

describe('draft validation', () => {
  it('accepts a well-formed draft', () => {
    const result = validateDraft(goodDraft, options);
    expect(result.issues).toEqual([]);
    expect(result.hashtags).toHaveLength(3);
    expect(result.fullText).toContain('#AgenticAI');
    expect(result.charCount).toBe(countChars(result.fullText));
  });

  it('flags posts that are too long', () => {
    const result = validateDraft({ ...goodDraft, body: 'word '.repeat(700) }, options);
    expect(result.issues.join(' ')).toContain('above the 2800 limit');
    expect(hardIssues(result.issues).length).toBeGreaterThan(0);
  });

  it('flags generic AI phrasing as a style issue', () => {
    const result = validateDraft(
      {
        ...goodDraft,
        hook: "In today's fast-paced world, AI changes everything about engineering work.",
      },
      options,
    );
    expect(result.issues.join(' ')).toContain('generic AI phrasing');
  });

  it('flags placeholder text as blocking', () => {
    const result = validateDraft(
      { ...goodDraft, body: `${goodDraft.body}\n\n[insert metric here]` },
      options,
    );
    expect(hardIssues(result.issues).join(' ')).toContain('placeholder');
  });

  it('flags too few hashtags', () => {
    const result = validateDraft({ ...goodDraft, hashtags: ['AI'] }, options);
    expect(result.issues.join(' ')).toContain('expected at least 3');
  });

  it('flags short bodies', () => {
    const result = validateDraft({ ...goodDraft, body: 'Too short.' }, options);
    expect(result.issues.join(' ')).toContain('too short');
  });
});
