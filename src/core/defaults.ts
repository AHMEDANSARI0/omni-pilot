import type { Settings } from './types';

export const DEFAULT_BRAND_VOICE =
  'First-person, professional voice of an AI engineer who builds agentic AI systems, automation workflows and Python/API integrations. Practical, specific, calm and confident. Writes about real engineering work, decisions and lessons learned - not personal-branding fluff.';

export const DEFAULT_WRITING_INSTRUCTIONS = [
  'Write LinkedIn posts that sound like an experienced engineer thinking out loud, not like an AI marketing tool.',
  '- Open with a specific hook: a concrete situation, problem or observation. Never open with "In today\'s fast-paced world", "Exciting news", "I\'m thrilled to share", or a question that exists only to bait comments.',
  '- One clear idea per post, earned with specifics: the problem, the approach, the trade-offs, what changed.',
  '- Plain, human professional English. Mix short and longer sentences. No buzzword stacking: no "game-changer", "revolutionary", "unlock the power", "delve".',
  '- Never invent statistics, research, client names, revenue numbers, testimonials or achievements. If a number is not supplied in the topic input, describe behaviour qualitatively.',
  '- At most two emojis and only if they add meaning. No hashtag stuffing.',
  '- End with a short takeaway and, only when it fits, one genuine question or call to action.',
  '- 120-220 words unless the topic demands otherwise. Optimise for reading on a phone.',
].join('\n');

export function defaultSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ownerTimezone: 'Asia/Karachi',
    generationTime: '08:00',
    publishTime: '09:30',
    publishDays: [1, 2, 3, 4, 5],
    respectPublishTime: true,
    autoPublishOnApproval: true,
    approvalTtlHours: 48,
    aiProvider: 'gemini',
    aiModel: 'gemini-2.5-flash',
    brandVoice: DEFAULT_BRAND_VOICE,
    writingInstructions: DEFAULT_WRITING_INSTRUCTIONS,
    hashtagMin: 3,
    hashtagMax: 5,
    maxPostChars: 2800,
    emailNotifications: true,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
