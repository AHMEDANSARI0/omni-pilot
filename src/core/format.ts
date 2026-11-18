import type { FormatResult } from './types';

const BANNED_OPENERS = [
  "in today's fast-paced world",
  'in today’s fast-paced world',
  'i’m thrilled to share',
  "i'm thrilled to share",
  'excited to announce',
  'as an ai language model',
  'unlock the power',
  'game-changer',
  'game changer',
  'revolutionary',
  'delve into',
  'in the ever-evolving',
  'let that sink in',
];

export interface FormatOptions {
  maxChars: number;
  hashtagMin: number;
  hashtagMax: number;
}

/** LinkedIn hashtags cannot contain spaces or punctuation; normalise rather than reject. */
export function normalizeHashtag(raw: string): string | null {
  const cleaned = raw
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return null;
  const joined = words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
  const hashtag = `#${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
  return hashtag.length > 1 && hashtag.length <= 40 ? hashtag : null;
}

export function normalizeHashtags(raw: readonly string[], options: FormatOptions): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of raw) {
    const normalized = normalizeHashtag(item);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= options.hashtagMax) break;
  }
  return output;
}

export function extractInlineHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return matches.map((match) => match.slice(1));
}

export function countChars(text: string): number {
  return Array.from(text).length;
}

export function composePost(hook: string, body: string, hashtags: readonly string[]): string {
  const hookText = hook.trim();
  const bodyText = body.trim();
  const blocks = [hookText, bodyText].filter((block) => block.length > 0);
  let text = blocks.join('\n\n');
  if (hashtags.length > 0) text += `\n\n${hashtags.join(' ')}`;
  return text.trim();
}

/** Split free-form edited text back into hook/body/hashtags so the DB stays consistent. */
export function splitPostText(text: string): { hook: string; body: string; hashtags: string[] } {
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  const trailing: string[] = [];
  while (lines.length > 0) {
    const last = (lines.at(-1) ?? '').trim();
    if (last.length === 0) {
      lines.pop();
      continue;
    }
    if (/^(#[\p{L}\p{N}_-]+\s*)+$/u.test(last)) {
      trailing.unshift(last);
      lines.pop();
      continue;
    }
    break;
  }
  const withoutTags = lines.join('\n').trim();
  const paragraphs = withoutTags.split(/\n{2,}/);
  const hook = (paragraphs[0] ?? '').trim();
  const body = paragraphs.slice(1).join('\n\n').trim();
  const hashtags = trailing.flatMap((line) => extractInlineHashtags(line));
  return { hook, body, hashtags };
}

export function validateDraft(
  draft: { hook: string; body: string; hashtags: readonly string[] },
  options: FormatOptions,
): FormatResult {
  const issues: string[] = [];
  const hashtags = normalizeHashtags(draft.hashtags, options);
  const hook = draft.hook.trim();
  const body = draft.body.trim();
  const fullText = composePost(hook, body, hashtags);
  const charCount = countChars(fullText);

  if (hook.length < 15) issues.push('Hook is too short to be meaningful.');
  if (body.length < 180) issues.push('Body is too short for a valuable post.');
  if (charCount > options.maxChars) {
    issues.push(`Post is ${charCount} characters, above the ${options.maxChars} limit.`);
  }
  if (hashtags.length < options.hashtagMin) {
    issues.push(`Only ${hashtags.length} hashtags; expected at least ${options.hashtagMin}.`);
  }
  if (hashtags.length > options.hashtagMax) {
    issues.push(`Too many hashtags (${hashtags.length}); max is ${options.hashtagMax}.`);
  }
  const lower = fullText.toLowerCase();
  const banned = BANNED_OPENERS.find((phrase) => lower.includes(phrase));
  if (banned) issues.push(`Contains generic AI phrasing: "${banned}".`);
  if (/\b(as an ai|language model)\b/i.test(fullText))
    issues.push('Post references being an AI model.');
  if (/(lorem ipsum|\[insert|todo:|placeholder)/i.test(fullText)) {
    issues.push('Post contains placeholder text.');
  }

  return { fullText, charCount, hashtags, hook, body, issues };
}

/** Issues that should block publishing entirely (style warnings do not). */
export function hardIssues(issues: readonly string[]): string[] {
  return issues.filter(
    (issue) =>
      issue.includes('above the') ||
      issue.includes('placeholder') ||
      issue.includes('references being an AI') ||
      issue.includes('too short to be meaningful'),
  );
}

export function stripHashtags(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^(#[\p{L}\p{N}_-]+\s*)+$/u.test(line.trim()))
    .join('\n')
    .trim();
}
