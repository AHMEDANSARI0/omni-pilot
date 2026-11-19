import { AppError } from './errors';
import type { AiProvider, Clock, Database } from './ports';
import type { Logger } from './logger';
import { localDate, localWeekday } from './time';
import { isPublishDay, slotForDate } from './schedule';
import { CONTENT_TYPES, type Settings, type Topic } from './types';
import { closest, DUPLICATE_THRESHOLD } from './duplicate';

/**
 * Phase 6 - "Suggest next week".
 *
 * One AI request produces a week of topics (angle + key points + audience). Nothing is
 * written to the database here: the owner reviews the list and adds what they like through
 * the same `POST /content/topics` path a manual topic uses, so there is exactly one way a
 * topic enters the queue.
 *
 * Two rules keep this honest:
 *   - a day that is not a publishing day is never suggested
 *   - a suggestion that matches an existing or recent topic is dropped, not renamed
 */

export const SUGGESTION_COUNT = 5;
/** Topics from this many past days are treated as "already covered". */
export const DUPLICATE_WINDOW_DAYS = 60;

export interface TopicSuggestionInput {
  settings: Settings;
  /** Existing topics (recent + upcoming) used for the duplicate guard. */
  existing: Topic[];
  /** Start of the window. Defaults to the day after `today`. */
  startDate?: string;
  today?: string;
  count?: number;
}

export interface SuggestedTopic {
  /** Suggested publishing date, already limited to the publishing days. */
  topicDate: string;
  topic: string;
  contentType: string;
  keyPoints: string;
  targetAudience: string;
  /** Why this one earned its slot. */
  rationale: string;
  /** Closest existing topic if the idea is too similar (then the row is dropped). */
  duplicateOf: string | null;
}

export interface SuggestionResult {
  suggestions: SuggestedTopic[];
  skipped: Array<{ topic: string; reason: string }>;
  windowStart: string;
  windowEnd: string;
  provider: string;
  model: string;
}

/**
 * Dates that are open for a new topic in the window: publishing days only, one topic per day,
 * and never a date that already has a topic.
 */
export function openPublishingDates(
  settings: Settings,
  options: { startDate: string; today: string; taken: Set<string>; count: number },
): string[] {
  const dates: string[] = [];
  let cursor = addIsoDays(options.startDate, 0);
  // A short window never needs more than a few weeks of scanning.
  for (let step = 0; step < 60 && dates.length < options.count; step += 1) {
    if (
      cursor >= options.startDate &&
      cursor >= options.today &&
      isPublishDay(settings, cursor) &&
      !options.taken.has(cursor)
    ) {
      dates.push(cursor);
    }
    cursor = addIsoDays(cursor, 1);
  }
  return dates;
}

/** ISO date arithmetic on the calendar date itself (no timezone drift). */
export function addIsoDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function buildSuggestionPrompt(input: {
  settings: Settings;
  dates: string[];
  recentTopics: Topic[];
  count: number;
}): { systemInstruction: string; prompt: string } {
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayList = input.dates
    .map((date) => {
      const weekday = weekdayNames[localWeekday(new Date(`${date}T12:00:00Z`), 'UTC')] ?? '';
      return `- ${date} (${weekday})`;
    })
    .join('\n');

  const covered = input.recentTopics.length
    ? input.recentTopics.map((topic) => `- ${topic.topic} (${topic.topicDate})`).join('\n')
    : '- (nothing yet)';

  const systemInstruction = `You are a content planner for a working AI engineer who writes on LinkedIn about agentic AI systems, AI automation, Python services and API integrations.

You propose concrete, buildable topics from real engineering work. You never invent results, metrics, employers or clients. You never propose generic motivational content, listicles or "top 10 tools" posts.

Respond with JSON only, matching this shape:
{"suggestions": [{"topic": string, "angle": string, "keyPoints": string, "audience": string, "contentType": string}]}

Rules:
- "topic" is one sentence, 6-16 words, specific enough to write from (a problem, a decision, a trade-off).
- "angle" is 1-4 words naming the take, e.g. "Failure story", "Short how-to", "Trade-off".
- "keyPoints" is 2-4 short factual bullets separated by "\\n", describing the engineering reality to cover. No invented numbers.
- "audience" is who this helps, e.g. "engineers building agent pipelines".
- "contentType" is one of: insight, how-to, story, opinion, announcement.`;

  const prompt = `Propose ${input.count} LinkedIn topics for these publishing days:
${dayList}

BRAND VOICE:
${input.settings.brandVoice}

WRITING INSTRUCTIONS:
${input.settings.writingInstructions}

TOPICS ALREADY COVERED (do not repeat, reword or split these):
${covered}

REQUIREMENTS:
- Exactly ${input.count} suggestions, in the order they should be published.
- Every suggestion must be a different shape of post (not ${input.count} variations of one idea).
- Prefer problems this engineer has actually solved over industry commentary.
- No hashtags, no emoji, no marketing language, no "In today's fast-paced world".
- Each keyPoints entry must be usable as source material without adding new facts.`;

  return { systemInstruction, prompt };
}

/**
 * The similarity maths lives in `duplicate.ts` (Phase 7), because daily generation needs the same
 * comparison. Re-exported here so existing callers and tests keep one import path.
 */
export { similarity, trigrams as trigramSet } from './duplicate';

/** The first stored topic that is too close to `topic`, or null. */
export function findDuplicate(topic: string, existing: Topic[], threshold?: number): Topic | null {
  return closest(topic, existing, (candidate) => candidate.topic, threshold)?.item ?? null;
}

function asText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Parses the AI payload defensively: a malformed suggestion is dropped, never repaired into
 * something the owner did not read.
 */
export function parseSuggestions(
  text: string,
  options: { count: number; dates: string[]; existing: Topic[]; settings: Settings },
): { suggestions: SuggestedTopic[]; skipped: Array<{ topic: string; reason: string }> } {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new AppError('AI_ERROR', 'The suggestion response was not valid JSON.', {
      details: { preview: cleaned.slice(0, 300) },
    });
  }

  const list = Array.isArray((parsed as Record<string, unknown>)?.suggestions)
    ? ((parsed as Record<string, unknown>).suggestions as unknown[])
    : [];

  const suggestions: SuggestedTopic[] = [];
  const skipped: Array<{ topic: string; reason: string }> = [];
  const produced: Topic[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const topic = asText(record.topic, 300);
    if (topic.length < 8) {
      skipped.push({ topic: topic || '(empty)', reason: 'Topic was too short to use.' });
      continue;
    }
    if (suggestions.length >= options.count) break;

    // Existing rows AND suggestions already accepted in this batch both count.
    const duplicate = findDuplicate(topic, [...options.existing, ...produced]);
    if (duplicate) {
      skipped.push({ topic, reason: `Too close to an existing topic: ${duplicate.topic}` });
      continue;
    }

    const date = options.dates[suggestions.length];
    if (!date) {
      skipped.push({ topic, reason: 'No open publishing day left in the window.' });
      continue;
    }

    const contentType = asText(record.contentType, 30).toLowerCase();
    const suggestion: SuggestedTopic = {
      topicDate: date,
      topic,
      contentType: CONTENT_TYPES.includes(contentType as (typeof CONTENT_TYPES)[number])
        ? contentType
        : 'insight',
      keyPoints: asText(record.keyPoints, 1200),
      targetAudience: asText(record.audience, 200),
      rationale: asText(record.angle, 60),
      duplicateOf: null,
    };
    suggestions.push(suggestion);
    produced.push({ ...emptyTopic(date, topic), contentType: suggestion.contentType });
  }

  return { suggestions, skipped };
}

function emptyTopic(date: string, topic: string): Topic {
  return {
    id: `suggested:${date}:${topic.slice(0, 24)}`,
    sheetRowNumber: null,
    topicDate: date,
    slotIndex: 0,
    topic,
    contentType: 'insight',
    keyPoints: null,
    targetAudience: null,
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * The whole flow: decide the open days, ask the AI once, validate, drop duplicates.
 * A failed request throws - the dashboard then shows the provider's message as-is.
 */
export async function suggestTopics(
  deps: {
    ai: AiProvider;
    clock: Clock;
    db: Pick<Database, 'listTopics'>;
  },
  input: TopicSuggestionInput,
  log?: Logger,
): Promise<SuggestionResult> {
  const today = input.today ?? localDate(deps.clock.now(), input.settings.ownerTimezone);
  const count = Math.min(Math.max(input.count ?? SUGGESTION_COUNT, 1), 7);
  const startDate = input.startDate ?? addIsoDays(today, 1);

  const taken = new Set(input.existing.map((topic) => topic.topicDate));
  const dates = openPublishingDates(input.settings, { startDate, today, taken, count });
  if (dates.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No open publishing day in the next few weeks. Add a publishing day or clear some topics first.',
    );
  }

  const recentFrom = addIsoDays(today, -DUPLICATE_WINDOW_DAYS);
  const recent = input.existing.filter((topic) => topic.topicDate >= recentFrom);
  const { systemInstruction, prompt } = buildSuggestionPrompt({
    settings: input.settings,
    dates,
    recentTopics: recent,
    count: dates.length,
  });

  const provider = deps.ai as AiProvider & {
    suggestTopics?: (args: { systemInstruction: string; prompt: string }, count: number) => Promise<string>;
  };
  if (typeof provider.suggestTopics !== 'function') {
    throw new AppError(
      'AI_ERROR',
      `${deps.ai.id} cannot propose topics. Switch the AI provider to Gemini in Settings.`,
    );
  }

  if (log) {
    await log.info('suggestions.requested', `Asking for ${dates.length} topic suggestions`, {
      provider: deps.ai.id,
      dates: dates.length,
      recentTopics: recent.length,
    });
  }

  const text = await provider.suggestTopics({ systemInstruction, prompt }, dates.length);
  const parsed = parseSuggestions(text, {
    count: dates.length,
    dates,
    existing: input.existing,
    settings: input.settings,
  });

  if (log) {
    await log.info(
      'suggestions.ready',
      `${parsed.suggestions.length} suggestion(s) ready, ${parsed.skipped.length} dropped`,
      { kept: parsed.suggestions.length, dropped: parsed.skipped.length },
    );
  }

  return {
    suggestions: parsed.suggestions,
    skipped: parsed.skipped,
    windowStart: dates[0] ?? startDate,
    windowEnd: dates[dates.length - 1] ?? startDate,
    provider: deps.ai.id,
    model: deps.ai.model,
  };
}

/** Which scheduled slot a suggested date belongs to (used by the UI copy). */
export function suggestionSlotLabel(settings: Settings, date: string): string {
  return slotForDate(settings, date).generationAt;
}
