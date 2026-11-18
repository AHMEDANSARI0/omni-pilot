import { AppError, safeErrorMessage } from '@/src/core/errors';
import { buildGenerationPrompt, buildVariantsPrompt } from '@/src/core/prompt';
import type { AiProvider, GeneratePostInput } from '@/src/core/ports';
import type { DraftContent, DraftVariant } from '@/src/core/types';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    hook: { type: 'STRING' },
    body: { type: 'STRING' },
    hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['hook', 'body', 'hashtags'],
} as const;

const VARIANTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    variants: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          angle: { type: 'STRING' },
          hook: { type: 'STRING' },
          body: { type: 'STRING' },
          hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['angle', 'hook', 'body', 'hashtags'],
      },
    },
  },
  required: ['variants'],
} as const;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}

/**
 * Google Gemini implementation of the AiProvider port.
 * Retries rate limits and transient server errors with exponential backoff, and asks
 * Gemini for schema-constrained JSON so parsing cannot silently produce garbage.
 */
export class GeminiProvider implements AiProvider {
  readonly id = 'gemini';
  readonly model: string;
  private readonly apiKey: string;
  private readonly http: typeof fetch;
  private readonly maxAttempts: number;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.http = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async generatePost(input: GeneratePostInput): Promise<DraftContent> {
    const { systemInstruction, prompt } = buildGenerationPrompt(input);
    const text = await this.request(systemInstruction, prompt, RESPONSE_SCHEMA, 2048);
    return parseDraft(text, this.id, this.model);
  }

  /**
   * Three drafts from one request: the free tier limits requests per minute/day, so asking
   * for variants in a single prompt is the only affordable way to offer a choice.
   */
  async generateVariants(input: GeneratePostInput, count: number): Promise<DraftVariant[]> {
    const wanted = Math.min(Math.max(count, 2), 4);
    const { systemInstruction, prompt } = buildVariantsPrompt(input, wanted);
    const text = await this.request(systemInstruction, prompt, VARIANTS_SCHEMA, 4096);
    return parseVariants(text, this.id, this.model, wanted);
  }

  private async request(
    systemInstruction: string,
    prompt: string,
    responseSchema: unknown,
    maxOutputTokens: number,
  ): Promise<string> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.9,
        topP: 0.95,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema,
      },
    });

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.http(
          `${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
            body,
            signal: AbortSignal.timeout(60_000),
          },
        );

        if (!response.ok) {
          const text = await response.text();
          const parsed = safeParse(text);
          const message = parsed?.error?.message ?? `Gemini returned ${response.status}`;
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.maxAttempts) {
            lastError = new AppError('AI_ERROR', message, { retryable: true });
            await sleep(750 * attempt * attempt);
            continue;
          }
          const hint =
            response.status === 401 || response.status === 403
              ? ' Check that GEMINI_API_KEY is valid and the Generative Language API is enabled.'
              : '';
          throw new AppError('AI_ERROR', `Gemini request failed: ${message}.${hint}`, {
            retryable,
            details: { status: response.status },
          });
        }

        const payload = (await response.json()) as GeminiResponse;
        const blockReason = payload.promptFeedback?.blockReason;
        if (blockReason) {
          throw new AppError('AI_ERROR', `Gemini blocked the prompt: ${blockReason}`, {
            details: { blockReason },
          });
        }
        const text =
          payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
        if (!text.trim()) {
          throw new AppError('AI_ERROR', 'Gemini returned an empty response', { retryable: true });
        }
        const finishReason = payload.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== 'STOP') {
          throw new AppError('AI_ERROR', `Gemini stopped early (${finishReason})`, {
            retryable: finishReason === 'MAX_TOKENS',
          });
        }
        return text;
      } catch (error) {
        if (error instanceof AppError) {
          if (error.retryable && attempt < this.maxAttempts) {
            lastError = error;
            await sleep(750 * attempt * attempt);
            continue;
          }
          throw error;
        }
        lastError = error;
        if (attempt < this.maxAttempts) {
          await sleep(750 * attempt * attempt);
          continue;
        }
        throw new AppError('AI_ERROR', `Gemini request failed: ${safeErrorMessage(error)}`, {
          retryable: true,
          cause: error,
        });
      }
    }
    throw new AppError(
      'AI_ERROR',
      `Gemini failed after ${this.maxAttempts} attempts: ${safeErrorMessage(lastError)}`,
    );
  }
}

export function parseDraft(text: string, provider: string, model: string): DraftContent {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new AppError(
      'AI_ERROR',
      `AI response was not valid JSON (provider ${provider}/${model})`,
      {
        details: { preview: cleaned.slice(0, 300) },
      },
    );
  }
  const record = parsed as Record<string, unknown>;
  const hook = typeof record.hook === 'string' ? record.hook.trim() : '';
  const body = typeof record.body === 'string' ? record.body.trim() : '';
  const hashtags = Array.isArray(record.hashtags)
    ? record.hashtags.filter((tag): tag is string => typeof tag === 'string')
    : typeof record.hashtags === 'string'
      ? record.hashtags.split(/[\s,]+/).filter(Boolean)
      : [];

  if (!hook || !body) {
    throw new AppError('AI_ERROR', 'AI response was missing the hook or body', {
      details: { preview: cleaned.slice(0, 300) },
    });
  }
  return { hook, body, hashtags };
}

export function parseVariants(
  text: string,
  provider: string,
  model: string,
  expected: number,
): DraftVariant[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new AppError(
      'AI_ERROR',
      `AI response was not valid JSON (provider ${provider}/${model})`,
      { details: { preview: cleaned.slice(0, 300) } },
    );
  }

  const record = parsed as Record<string, unknown>;
  const raw = Array.isArray(record.variants) ? record.variants : [];
  const variants: DraftVariant[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    try {
      const draft = parseDraft(JSON.stringify(item), provider, model);
      const angle =
        typeof (item as Record<string, unknown>).angle === 'string'
          ? String((item as Record<string, unknown>).angle)
              .trim()
              .slice(0, 60)
          : '';
      variants.push({ ...draft, angle: angle || `Option ${variants.length + 1}` });
    } catch {
      // Skip a malformed option instead of losing the whole batch.
    }
    if (variants.length >= expected) break;
  }

  if (variants.length === 0) {
    throw new AppError('AI_ERROR', 'AI response had no usable variants', {
      details: { preview: cleaned.slice(0, 300) },
    });
  }
  return variants;
}

function safeParse(text: string): GeminiResponse | null {
  try {
    return JSON.parse(text) as GeminiResponse;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
