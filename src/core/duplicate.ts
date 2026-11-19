/**
 * Phase 7 - near-duplicate protection.
 *
 * A topic or a hook that repeats something from the last six months is worse than no post at all:
 * it bores the only reader who matters (the owner's network) and it makes the pipeline look like a
 * content farm. So both entry points check before they write:
 *
 *   - "Suggest next week"      -> an idea too close to an existing topic is dropped, with the reason
 *   - daily generation          -> a draft whose hook/body repeats recent work is retried once, then
 *                                  flagged for the owner instead of being published quietly
 *
 * The measurement is word-trigram Jaccard: order-insensitive, dependency-free, and good enough to
 * catch "Why every agent tool call needs an idempotency key" vs "Idempotency keys for agent tools".
 * It is deliberately NOT fuzzy-matching single words - that produces false positives that would
 * silently kill legitimate follow-ups.
 */

/** Similarity above this counts as "the same idea". Tuned against the tests in duplicate.test.ts. */
export const DUPLICATE_THRESHOLD = 0.55;
/** Hooks are shorter than topics, so the same threshold is stricter in practice; kept explicit. */
export const HOOK_THRESHOLD = 0.62;
/** How far back the guard looks. Six months, as promised in the roadmap. */
export const DUPLICATE_WINDOW_DAYS = 180;

/** Words that carry no meaning on their own - removed before the comparison. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'how', 'i', 'in', 'into',
  'is', 'it', 'its', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'then', 'there',
  'these', 'this', 'to', 'was', 'we', 'what', 'when', 'which', 'why', 'with', 'you', 'your',
]);

/** Normalised word list: lowercase, punctuation stripped, stop words removed, light stemming. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

/**
 * Very light stemming: plural and common suffix folding. Not linguistics - just enough that
 * "retries"/"retry" and "publishing"/"publish" compare equal.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  // Fold a plural only when at least two letters are left behind ("ids" -> "id", "as" stays "as").
  if (word.length >= 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  return word;
}

/** Word-trigram set over the normalised text. */
export function trigrams(text: string): Set<string> {
  const tokens = words(text);
  const set = new Set<string>();
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    set.add(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`);
  }
  return set;
}

/** Jaccard similarity of the trigram sets, 0..1. Both sides need at least three words. */
export function similarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export interface DuplicateMatch<T> {
  item: T;
  score: number;
}

/**
 * The closest candidate at or above `threshold`, or null.
 *
 * `pick` lets the caller compare against different text fields (a topic row has `topic`, a post has
 * `hook` and `body`) without this module knowing their shape.
 */
export function closest<T>(
  text: string,
  candidates: T[],
  pick: (candidate: T) => string,
  threshold: number = DUPLICATE_THRESHOLD,
): DuplicateMatch<T> | null {
  let best: DuplicateMatch<T> | null = null;
  for (const candidate of candidates) {
    const score = similarity(text, pick(candidate));
    if (score >= threshold && (!best || score > best.score)) best = { item: candidate, score };
  }
  return best ? { item: best.item, score: Math.round(best.score * 100) / 100 } : null;
}

/** Only keep records inside the duplicate window (older work may be revisited on purpose). */
export function withinWindow<T>(
  records: T[],
  days: number,
  getDate: (record: T) => string | null,
  today: string,
): T[] {
  if (days <= 0) return [];
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  // `days: 180` means "180 days back plus today itself", which is 181 calendar days inclusive.
  const cutoff = todayMs - days * 86_400_000;
  return records.filter((record) => {
    const date = getDate(record);
    if (!date) return false;
    const ms = new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime();
    return Number.isFinite(ms) && ms >= cutoff && ms <= todayMs + 86_400_000;
  });
}

export interface DraftCheck {
  /** True when the draft repeats recent work. */
  duplicate: boolean;
  /** What it repeats (for the log and the owner-facing warning). */
  matchOf: string | null;
  score: number;
  /** Why it was flagged, in one sentence the owner can act on. */
  reason: string | null;
}

/**
 * Checks a generated draft against recent posts. The hook is compared first (it is the part readers
 * notice repeating); the body is only compared when the hook passes, which keeps a legitimate post
 * on a familiar topic from being rejected for re-using common phrasing.
 */
export function checkDraft(
  draft: { hook: string; body: string },
  recent: Array<{ hook: string; body: string; runDate: string }>,
  options: { threshold?: number } = {},
): DraftCheck {
  const hookMatch = closest(draft.hook, recent, (post) => post.hook, options.threshold ?? HOOK_THRESHOLD);
  if (hookMatch) {
    return {
      duplicate: true,
      matchOf: hookMatch.item.hook,
      score: hookMatch.score,
      reason: `The opening repeats a post from ${hookMatch.item.runDate} (${Math.round(hookMatch.score * 100)}% similar)`,
    };
  }
  const bodyMatch = closest(draft.body, recent, (post) => post.body, DUPLICATE_THRESHOLD);
  if (bodyMatch) {
    return {
      duplicate: true,
      matchOf: bodyMatch.item.hook,
      score: bodyMatch.score,
      reason: `The body repeats the post from ${bodyMatch.item.runDate} (${Math.round(bodyMatch.score * 100)}% similar)`,
    };
  }
  return { duplicate: false, matchOf: null, score: 0, reason: null };
}
