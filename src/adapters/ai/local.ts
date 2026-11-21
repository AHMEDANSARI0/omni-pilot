import type { AiProvider, GeneratePostInput } from '@/src/core/ports';
import type { DraftContent, DraftVariant } from '@/src/core/types';

/**
 * How many distinct drafts this stub can produce.
 *
 * It was four. Four is enough for one post, and not enough for a *history*: the duplicate guard compares a new
 * draft against the last 180 days, so with four shapes the same body comes back every fifth post and
 * `e2e/safety.spec.ts` failed intermittently - `Received: "failed"` after two attempts of the same text. Twelve
 * shapes over four sentence lists makes an accidental repeat inside one window unlikely, and a repeat from an
 * earlier *day* is still caught, which is what the guard is for.
 */
const ANGLES = [
  'Failure story',
  'Short how-to',
  'Trade-off',
  'What I would change',
  'Misdiagnosis',
  'Small win',
  'Cost breakdown',
  'Before and after',
  'One-line rule',
  'What I got wrong',
  'Through the logs',
  'Why it is boring',
] as const;

/**
 * Deterministic offline provider for local development and tests.
 * It is clearly labelled in the UI/logs (provider "local-dev") and is impossible to
 * select when APP_ENV=production.
 */
export class LocalAiProvider implements AiProvider {
  readonly id = 'local-dev';
  readonly model = 'local-dev-template';

  async generatePost(input: GeneratePostInput): Promise<DraftContent> {
    // No position to ask for: derive one from the slot and the topic, so two posts of one day differ and two
    // unrelated topics in different runs differ too.
    return this.draftAt(input, (input.slotIndex ?? 0) + this.angleFor(input.topic));
  }

  /**
   * Phase 10: two posts on the same day are normal, so the offline drafts have to be able to differ.
   * The variant is chosen from the topic's own words - deterministic, but not identical for every topic -
   * otherwise a second slot's draft would trip the duplicate guard on the first slot's body.
   */
  private angleFor(topic: string): number {
    const hash = [...topic].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 7);
    return hash % ANGLES.length;
  }

  async generateVariants(input: GeneratePostInput, count: number): Promise<DraftVariant[]> {
    const total = Math.min(Math.max(count, 2), ANGLES.length);
    // A retry must not lead with the draft that was just refused: option 0 is the one the pipeline keeps, so
    // echoing it fails the run for exactly the text it was told to avoid. Starting the second attempt after the
    // first attempt's whole set (3 of 12) is the only way to guarantee that - and 12 shapes, not 4, is what makes
    // the set disjoint at all.
    //
    // The set is chosen here and passed down explicitly. It used to be half-derived inside `draft()`, which
    // ignored the position it was given for angle 0 - so the first attempt's first draft and the retry's first
    // draft landed on the same angle no matter what the offset said.
    const retried = /previous drafts had these problems/i.test(input.writingInstructions ?? '');
    const base = (input.slotIndex ?? 0) + this.angleFor(input.topic) + (retried ? total : 0);
    return Array.from({ length: total }, (_, position) => {
      const angle = (base + position) % ANGLES.length;
      return { ...this.draftAt(input, angle), angle: ANGLES[angle] ?? `Option ${position + 1}` };
    });
  }

  /**
   * Deterministic offline suggestions so the Phase 6 UI works with no API key.
   * Clearly themed around the local provider's subject matter, and never presented as live AI.
   */
  async suggestTopics(
    _input: { systemInstruction: string; prompt: string },
    count: number,
  ): Promise<string> {
    const ideas = [
      {
        topic: 'Why every agent tool call needs an idempotency key',
        angle: 'Failure story',
        keyPoints: 'A retried tool call created duplicate records\nThe fix was a stored key per call\nRetries now resume instead of repeating',
        audience: 'engineers building agent pipelines',
        contentType: 'story',
      },
      {
        topic: 'A short how-to for typed failures in agent workflows',
        angle: 'Short how-to',
        keyPoints: 'Every step returns a typed reason, not a stack trace\nThe orchestrator decides retry vs fail\nLogs become readable',
        audience: 'backend engineers',
        contentType: 'how-to',
      },
      {
        topic: 'The trade-off between retries and duplicate side effects',
        angle: 'Trade-off',
        keyPoints: 'Retries hide failures until they duplicate them\nIdempotency costs one write per step\nThat write pays for itself on the first timeout',
        audience: 'automation leads',
        contentType: 'opinion',
      },
      {
        topic: 'What I would change about my first scheduler design',
        angle: 'What I would change',
        keyPoints: 'Time zones were an afterthought\nDatabase claims beat in-memory locks\nFailures needed to be visible, not logged quietly',
        audience: 'engineers writing cron jobs',
        contentType: 'insight',
      },
      {
        topic: 'Cost control for a free-tier AI pipeline',
        angle: 'Field note',
        keyPoints: 'One request per run instead of one per variant\nHard limits in code, not in a dashboard\nFailures stop the run instead of retrying forever',
        audience: 'solo builders on free tiers',
        contentType: 'insight',
      },
    ];
    const total = Math.min(Math.max(count, 1), ideas.length);
    return JSON.stringify({ suggestions: ideas.slice(0, total) });
  }

  /**
   * One draft, from one angle.
   *
   * The caller always names the angle now. It used to default to "0 means derive it from the slot and the topic",
   * which quietly made angle 0 impossible to request - and that is exactly the position a retry needs to avoid,
   * so the retry kept landing on the same first draft as the attempt before it.
   */
  private draftAt(input: GeneratePostInput, angle: number): DraftContent {
    const topic = lowerFirst(input.topic);
    const index = ((angle % ANGLES.length) + ANGLES.length) % ANGLES.length;
    const keyPoint = input.keyPoints?.split(/\n|;/)[0]?.trim();

    const hooks = [
      `Most agent workflows fail on the boring part: ${topic}.`,
      `The fix for ${topic} was smaller than the code I deleted.`,
      `I would not build ${topic} the way I did the first time.`,
      `Everyone measures ${topic} by demo speed. The real cost shows up on retries.`,
      `The expensive part of ${topic} was invisible until I started timing the failures.`,
      `Nobody warns you that ${topic} is mostly bookkeeping.`,
    ];

    /**
     * The topic appears in three of the four paragraphs on purpose. This provider has no model behind
     * it, so without that the drafts for two unrelated topics would share almost every word and the
     * Phase 7 duplicate guard would reject the second post of the day - a false negative caused by the
     * stub, not by the pipeline.
     */
    const openings = [
      keyPoint
        ? `Here is the part of ${topic} that mattered in practice: ${keyPoint}`
        : `The interesting failure in ${topic} was never the model call. It was everything wrapped around it: retries, state, and knowing what actually happened.`,
      `The change that helped most with ${topic} took one afternoon: write the status of every step before the call, not after it.`,
      `Two weeks of noisy logs around ${topic} taught me less than one line that recorded which step had already run.`,
      `The cost of ${topic} was never the tokens. It was the hour spent reconstructing what the pipeline thought it was doing.`,
      `I could not say what ${topic} had done on a bad night, and that was the whole problem.`,
      `Every incident around ${topic} started the same way: a step that ran twice and left no trace.`,
    ];
    const middles = [
      `In the first version of ${topic} every step called the model directly. It worked in demos and fell apart the moment one call timed out, because there was no record of what had already run.`,
      `Nothing in that code looked wrong. The retry simply ran the same step twice and nobody could tell me which copy had won.`,
      `The dashboard showed green while the database held two records for one decision, so the monitoring around ${topic} was measuring the wrong thing.`,
      `Every failure looked identical in the logs until each step returned a typed reason instead of a stack trace.`,
      `The retry was correct and the outcome was still wrong, because nothing knew what had already succeeded.`,
      `Two writes for one decision, and no column that said which of them the customer saw.`,
    ];
    const endings = [
      `For ${topic} the fix was unglamorous: an idempotent step, a stored key, and a status written before and after. Debugging went from guesswork to reading a log line.`,
      `I capped attempts at three, made the delay grow, and let the last failure be loud instead of retried into silence.`,
      `Now the retry behind ${topic} resumes from the recorded state. Duplicates stopped appearing and the on-call alert became specific.`,
      `A single table of step outcomes replaced four ad-hoc flags, and the failure path became something I could read in seconds.`,
      `One recorded status per step turned a nightly mystery into a query I could run at breakfast.`,
      `The fix held because the second attempt could see what the first one had finished.`,
    ];
    const closers = [
      `If you are building ${topic}, design the failure path before the happy path. The happy path is the easy half.`,
      `If ${topic} is on your roadmap, write the failure case first. It is where the real design lives.`,
      `Whatever you build around ${topic}, make the failure visible. Silent retries are the expensive ones.`,
      `The lesson from ${topic} is unglamorous: record state before the call, and the rest gets simpler.`,
      `If it matters that the step ran once, write that down where the retry can read it.`,
      `Start with the failure path around ${topic}; the happy path will take care of itself.`,
    ];

    const body = [
      openings[index % openings.length]!,
      middles[index % middles.length]!,
      endings[index % endings.length]!,
      closers[index % closers.length]!,
    ].join('\n\n');

    return {
      hook: hooks[index % hooks.length] ?? hooks[0]!,
      body,
      hashtags: [
        'AIAutomation',
        'AgenticAI',
        input.contentType === 'how-to' ? 'HowTo' : 'Engineering',
      ],
    };
  }
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
