import type { GeneratePostInput } from './ports';

const SYSTEM_PROMPT = `You are a ghostwriter for a working AI engineer who builds agentic AI systems, AI automation, Python services and API integrations.

You write LinkedIn posts in the first person, as that engineer, in natural professional English. You are concrete, calm and useful. You never invent achievements, employers, clients, statistics, research or case studies. You never write marketing filler.

Respond with JSON only, matching this shape:
{"hook": string, "body": string, "hashtags": string[]}

Rules for the JSON:
- "hook" is 1-2 sentences (max 220 characters). It must be specific: a concrete problem, observation or decision. No clickbait.
- "body" is the substance: 2-5 short paragraphs separated by "\\n\\n". Explain the problem, the approach, the trade-offs and what actually changed. No bullet characters like "•", use short sentences instead. Do not repeat the hook.
- "hashtags" are bare tags without the "#" character, 2-4 words each, no spaces.
- Do not include the hashtags inside the body.
- Total post length (hook + body) must stay under the requested character budget.`;

export function buildGenerationPrompt(input: GeneratePostInput): {
  systemInstruction: string;
  prompt: string;
} {
  const budget = Math.max(300, input.maxChars - 120);
  const recent = input.recentHooks.length
    ? input.recentHooks.map((hook) => `- ${hook}`).join('\n')
    : '- (none yet)';

  // Phase 7: the owner's own outcomes, not a model's opinion. Empty string when there is no data,
  // so the prompt never grows a section that only says "none".
  const library = (input.hookLibrary ?? '').trim();
  const libraryBlock = library ? `\n${library}\n` : '';

  const prompt = `Write one LinkedIn post.

TOPIC: ${input.topic}
CONTENT TYPE: ${input.contentType}
KEY POINTS / SOURCE MATERIAL (use only this, never invent facts): ${input.keyPoints?.trim() || 'none supplied - stay general and honest, describe engineering reality without fake specifics'}
TARGET AUDIENCE: ${input.targetAudience?.trim() || 'engineers, technical founders and automation leads'}

BRAND VOICE:
${input.brandVoice}

WRITING INSTRUCTIONS (mandatory):
${input.writingInstructions}

RECENT HOOKS - do not reuse these openings or structures:
${recent}
${libraryBlock}
REQUIREMENTS:
- ${input.hashtagMin} to ${input.hashtagMax} hashtags, relevant to the topic, no stuffy generic tags like #Motivation or #Success.
- Keep hook + body under ${budget} characters.
- Readable on a phone: short paragraphs, no walls of text.
- No emoji unless it genuinely helps; maximum two.
- Do not mention that the post was generated, and do not add commentary about LinkedIn.`;

  return { systemInstruction: SYSTEM_PROMPT, prompt };
}

/**
 * One request, several drafts. Each option must take a different angle, otherwise the owner
 * is just choosing between three copies of the same post.
 */
export function buildVariantsPrompt(
  input: GeneratePostInput,
  count: number,
): { systemInstruction: string; prompt: string } {
  const base = buildGenerationPrompt(input);
  const budget = Math.max(300, input.maxChars - 120);

  const prompt = `${base.prompt}

Instead of one post, write ${count} clearly different options for the SAME topic.
Each option must use a different angle and a different opening structure, for example: a specific failure story, a short how-to, a trade-off/opinion, or a "what I would do differently" note.
Do not repeat a hook or an opening line between options.
Every option must stay honest: no invented metrics, employers or results.
Each option keeps hook + body under ${budget} characters and ${input.hashtagMin}-${input.hashtagMax} hashtags.

Respond with JSON only, matching this shape:
{"variants": [{"angle": string, "hook": string, "body": string, "hashtags": string[]}]}

"angle" is a label of 1-4 words naming the take, e.g. "Failure story" or "Trade-off".`;

  return { systemInstruction: base.systemInstruction, prompt };
}
