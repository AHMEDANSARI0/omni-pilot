import { z } from 'zod';
import { CONTENT_TYPES } from '@/src/core/types';
import { isValidTimeZone } from '@/src/config/env';

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Use HH:MM (24 hour)');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const settingsPatchSchema = z
  .object({
    ownerTimezone: z.string().min(1).refine(isValidTimeZone, 'Unknown IANA timezone'),
    generationTime: timeSchema,
    publishTime: timeSchema,
    // Phase 10: every slot of the day, in order. One entry = the old single-post behaviour.
    publishTimes: z.array(timeSchema).min(1).max(5),
    publishDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    respectPublishTime: z.boolean(),
    autoPublishOnApproval: z.boolean(),
    approvalTtlHours: z.number().int().min(1).max(336),
    aiModel: z.string().min(3).max(120),
    brandVoice: z.string().min(20).max(4000),
    writingInstructions: z.string().min(20).max(8000),
    hashtagMin: z.number().int().min(1).max(10),
    hashtagMax: z.number().int().min(1).max(10),
    maxPostChars: z.number().int().min(300).max(3000),
    emailNotifications: z.boolean(),
  })
  .partial()
  .strict();

export const topicCreateSchema = z
  .object({
    topicDate: isoDateSchema,
    topic: z.string().min(5).max(300),
    contentType: z.enum(CONTENT_TYPES).default('insight'),
    /** Phase 10: which post of the day this topic feeds. Omitted means the first slot. */
    slotIndex: z.number().int().min(0).max(4).optional(),
    keyPoints: z.string().max(4000).nullish(),
    targetAudience: z.string().max(500).nullish(),
    /**
     * Phase 7: `true` keeps the topic even when it repeats recent work. Without it the request is
     * refused with the match, so a duplicate can never enter the queue by accident - only on purpose.
     */
    allowDuplicate: z.boolean().optional(),
  })
  .strict();

export const topicPatchSchema = z
  .object({
    status: z.enum(['pending', 'skipped']),
  })
  .strict();

/** Phase 6: ask for a week of topic ideas (nothing is stored). */
export const suggestionSchema = z
  .object({
    count: z.number().int().min(1).max(7).optional(),
    startDate: isoDateSchema.optional(),
  })
  .strict();

/** Phase 6: add the suggestions the owner kept. Dates already taken are refused, not replaced. */
export const suggestionAcceptSchema = z
  .object({
    topics: z
      .array(
        z
          .object({
            topicDate: isoDateSchema,
            topic: z.string().min(5).max(300),
            contentType: z.enum(CONTENT_TYPES).default('insight'),
            keyPoints: z.string().max(4000).nullish(),
            targetAudience: z.string().max(500).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(7),
  })
  .strict();

export const postPatchSchema = z
  .object({
    fullText: z.string().min(50).max(3000),
  })
  .strict();

export const generateSchema = z
  .object({
    runDate: isoDateSchema.optional(),
    /** Phase 10: which post of the day. Omitted means the first slot, i.e. the old behaviour. */
    slotIndex: z.number().int().min(0).max(4).optional(),
    sendEmail: z.boolean().optional(),
    skipSync: z.boolean().optional(),
  })
  .strict();

export const scheduleRunSchema = z
  .object({
    force: z.boolean().optional(),
    runDate: isoDateSchema.optional(),
  })
  .strict();

export const approvalDecisionSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const dashboardDecisionSchema = approvalDecisionSchema;

export const manualPublishSchema = z
  .object({
    url: z
      .string()
      .url()
      .regex(/^https:\/\/(www\.)?(linkedin\.com|lnkd\.in)\//i, 'Must be a LinkedIn URL'),
  })
  .strict();

export const approvalQuerySchema = z
  .object({
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const postsQuerySchema = z
  .object({
    status: z.string().optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const logsQuerySchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    event: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export const sheetConfigSchema = z
  .object({
    sheetId: z.string().min(10).max(200).optional(),
    sheetUrl: z.string().url().optional(),
    sheetTab: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.sheetId || value.sheetUrl || value.sheetTab), {
    message: 'Provide sheetId, sheetUrl or sheetTab',
  });

export const providerParamSchema = z.enum(['google_sheets', 'linkedin']);

type Parseable<T> = {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: z.ZodError };
};

export function parseOrThrow<T>(schema: Parseable<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const error = new Error(
      details.map((detail) => `${detail.path || 'body'}: ${detail.message}`).join('; '),
    );
    error.name = 'ValidationError';
    (error as Error & { details?: unknown }).details = details;
    throw error;
  }
  return result.data;
}
