/**
 * Phase 7 - the hook library.
 *
 * Every published post teaches the system something: which openings actually carried a post. This
 * module turns the post history into a small, readable library - no new table, no manual curation -
 * and decides which openings go back into the next prompt.
 *
 * Honesty rules:
 *   - "worked" is measured from real outcomes (published, approved, rejected) - never from a model's
 *     opinion, and never invented when there is no data
 *   - a hook is only re-used as *inspiration*; the prompt says so, and duplicate protection still
 *     rejects a draft that copies one
 *   - a rejected hook is kept as a warning, not deleted: the mistake is the useful part
 */

export type HookOutcome = 'published' | 'approved' | 'pending' | 'rejected' | 'failed';

export interface HookRecord {
  hook: string;
  outcome: HookOutcome;
  /** ISO date of the post this hook came from. */
  runDate: string;
  /** Pattern label, e.g. "failure story" - derived from the shape of the sentence. */
  pattern: string;
}

export interface HookLibrary {
  /** Hooks that led to a published post, newest first. */
  proven: HookRecord[];
  /** Hooks whose post is waiting for a decision - not yet evidence either way. */
  waiting: HookRecord[];
  /** Hooks the owner rejected. Kept so the next prompt can avoid the shape, not just the words. */
  rejected: HookRecord[];
  /** Pattern -> count, over the proven hooks. */
  patterns: Array<{ pattern: string; count: number }>;
  /** One line the dashboard can show without dressing it up. */
  summary: string;
}

// Suffix-tolerant on purpose: "failing", "broken", "bugs" are the same shape as "fail", and a
// pattern that only matches the exact past tense labels half the library as "plain statement".
const PATTERNS: Array<{ label: string; test: RegExp }> = [
  { label: 'failure story', test: /\b(fail\w*|broke\w*|broken|outage\w*|incident\w*|went wrong|bug\w*)\b/i },
  { label: 'trade-off', test: /\b(trade-?offs?|instead of|versus|vs\.?|cost of|gave up|pick one)\b/i },
  { label: 'short how-to', test: /\b(how (i|to|we)|here'?s how|steps?|checklist)\b/i },
  { label: 'observation', test: /\b(noticed|notices|realised|realized|learned|learnt|turns out)\b/i },
  { label: 'question', test: /^\s*(why|what|how|when|should|do you|have you)\b/i },
  { label: 'number', test: /\b\d+\b/ },
];

/** Labels the shape of a hook. Multiple patterns are possible; the first match wins for stability. */
export function hookPattern(hook: string): string {
  for (const pattern of PATTERNS) {
    if (pattern.test.test(hook)) return pattern.label;
  }
  return 'plain statement';
}

/**
 * How many proven hooks go into the next prompt. Small on purpose: eight examples that all look
 * alike produce eight drafts that all look alike.
 */
export const PROMPT_HOOK_LIMIT = 5;

/** Maps a post status onto the library's vocabulary. Unknown statuses are treated as waiting. */
export function outcomeOf(status: string): HookOutcome {
  switch (status) {
    case 'published':
      return 'published';
    case 'approved':
      return 'approved';
    case 'rejected':
    case 'expired':
      return 'rejected';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * Builds the library from post rows. Pure: the caller supplies the rows, so the same function powers
 * the API endpoint and the tests.
 */
export function buildHookLibrary(
  posts: Array<{ hook: string; status: string; runDate: string }>,
  limit: number = PROMPT_HOOK_LIMIT,
): HookLibrary {
  const records: HookRecord[] = posts
    .filter((post) => post.hook.trim().length > 0)
    .map((post) => ({
      hook: post.hook.trim(),
      outcome: outcomeOf(post.status),
      runDate: post.runDate,
      pattern: hookPattern(post.hook),
    }))
    // Newest first: recent work is the best predictor of what the audience is following right now.
    .sort((a, b) => b.runDate.localeCompare(a.runDate) || a.hook.localeCompare(b.hook));

  const proven = records.filter((record) => record.outcome === 'published').slice(0, limit);
  const waiting = records
    .filter((record) => record.outcome === 'approved' || record.outcome === 'pending')
    .slice(0, limit);
  const rejected = records.filter((record) => record.outcome === 'rejected').slice(0, limit);

  const counts = new Map<string, number>();
  for (const record of proven) counts.set(record.pattern, (counts.get(record.pattern) ?? 0) + 1);
  const patterns = [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));

  const summary =
    proven.length === 0
      ? 'No published post yet - the library fills itself after the first one goes live.'
      : `${proven.length} proven hook(s), mostly "${patterns[0]?.pattern ?? 'plain statement'}".`;

  return { proven, waiting, rejected, patterns, summary };
}

/**
 * The hook guidance block for the generation prompt.
 *
 * Returns an empty string when there is nothing honest to say, so the prompt does not grow a section
 * that only contains "none".
 */
export function hookGuidance(library: HookLibrary): string {
  if (library.proven.length === 0 && library.rejected.length === 0) return '';

  const lines: string[] = [];
  if (library.proven.length > 0) {
    lines.push('OPENINGS THAT WORKED (reuse the *shape*, never the wording):');
    for (const record of library.proven) {
      lines.push(`- [${record.pattern}] ${record.hook}`);
    }
  }
  if (library.rejected.length > 0) {
    lines.push('OPENINGS THE OWNER REJECTED (do not repeat this shape):');
    for (const record of library.rejected) {
      lines.push(`- [${record.pattern}] ${record.hook}`);
    }
  }
  if (library.patterns.length > 1) {
    lines.push(
      `Most of the proven hooks are "${library.patterns[0]!.pattern}"; at least one draft should use a different pattern.`,
    );
  }
  return lines.join('\n');
}
