import type { AiProvider, GeneratePostInput } from '@/src/core/ports';
import type { DraftContent, DraftVariant } from '@/src/core/types';

const ANGLES = ['Failure story', 'Short how-to', 'Trade-off', 'What I would change'] as const;

/**
 * Deterministic offline provider for local development and tests.
 * It is clearly labelled in the UI/logs (provider "local-dev") and is impossible to
 * select when APP_ENV=production.
 */
export class LocalAiProvider implements AiProvider {
  readonly id = 'local-dev';
  readonly model = 'local-dev-template';

  async generatePost(input: GeneratePostInput): Promise<DraftContent> {
    return this.draft(input, 0);
  }

  async generateVariants(input: GeneratePostInput, count: number): Promise<DraftVariant[]> {
    const total = Math.min(Math.max(count, 2), ANGLES.length);
    return Array.from({ length: total }, (_, index) => ({
      ...this.draft(input, index),
      angle: ANGLES[index] ?? `Option ${index + 1}`,
    }));
  }

  private draft(input: GeneratePostInput, index: number): DraftContent {
    const topic = lowerFirst(input.topic);
    const keyPoint = input.keyPoints?.split(/\n|;/)[0]?.trim();
    const hooks = [
      `Most agent workflows fail on the boring part: ${topic}.`,
      `The fix for ${topic} was smaller than the code I deleted.`,
      `I would not build ${topic} the way I did the first time.`,
      `Everyone measures ${topic} by demo speed. The real cost shows up on retries.`,
    ];
    const hook = hooks[index % hooks.length] ?? hooks[0]!;

    const body = [
      index === 1
        ? 'The change that helped most took one afternoon: write the status of every step before the call, not after it.'
        : keyPoint
          ? `Here is the part that mattered in practice: ${keyPoint}`
          : `The interesting failure was never the model call. It was everything wrapped around it: retries, state, and knowing what actually happened.`,
      `In the first version every step called the model directly. It worked in demos and fell apart the moment one call timed out, because there was no record of what had already run.`,
      `The fix was unglamorous. Each step became an idempotent function with a stored key, the orchestration layer recorded status before and after, and failures returned a typed reason instead of a stack trace. Debugging went from guesswork to reading a log.`,
      `If you are building ${topic}, design the failure path before the happy path. The happy path is the easy half.`,
    ].join('\n\n');

    return {
      hook,
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
