// The single Anthropic client and the one JSON-shaped call every AI route uses.
//
// Every route used to build its own OpenAI client, its own "return raw JSON, no
// code fences" plea, and its own JSON.parse-and-hope. Structured outputs make
// the shape a contract the API enforces, so the parsing here is a formality
// rather than the place things break.

import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY || Bun.env.ANTHROPIC_API_KEY;

// The SDK constructs happily without a key and only fails at request time, so a
// missing key surfaces as a generic 500 the first time someone taps Suggest
// Meals — with nothing in the response pointing at the cause. Say it at boot.
if (!apiKey) {
  console.warn(
    '\n\x1b[33mANTHROPIC_API_KEY is not set.\x1b[0m Meal suggestions, recipe import\n' +
    '(URL and photo) and list categorization will all fail at request time.\n' +
    'Add it to apps/api/.env — see .env.example.\n',
  );
}

export const anthropic = new Anthropic({ apiKey });

// Per-route model choice lives here so switching one route is a one-line edit
// rather than a hunt through five files. Opus is the default across the board;
// the cheap-and-cheerful routes (categorize especially) are the first place to
// try a smaller model if the bill argues for it.
export const models = {
  recipeImport: 'claude-opus-5',
  recipePhoto: 'claude-opus-5',
  mealSuggest: 'claude-opus-5',
  categorize: 'claude-opus-5',
} as const;

export interface JsonCallOptions {
  model: string;
  /**
   * Instructions that do not vary between requests. Cached when `cacheSystem`
   * is left on, so repeat calls only pay full price for the user turn.
   */
  system: string;
  /** Per-request content. Anything that changes call to call belongs here, not in `system`. */
  user: string | Anthropic.ContentBlockParam[];
  /** JSON Schema the response is constrained to. Objects need `additionalProperties: false`. */
  schema: Record<string, unknown>;
  /** Thinking depth and overall token spend. Defaults to `low`. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /** Turn off when the system prompt is assembled per request — caching a unique prefix is pure cost. */
  cacheSystem?: boolean;
}

export class ClaudeError extends Error {}

/**
 * One Claude call whose response is guaranteed to match `schema`.
 *
 * Throws rather than returning a partial: a truncated or refused response
 * parses to something schema-shaped-but-wrong far too easily, and callers all
 * want the same "give up and show an error" behaviour.
 */
export async function completeJson<T>({
  model,
  system,
  user,
  schema,
  effort = 'low',
  maxTokens = 16000,
  cacheSystem = true,
}: JsonCallOptions): Promise<T> {
  const message = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: 'text',
        text: system,
        ...(cacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ],
    output_config: {
      effort,
      format: { type: 'json_schema', schema },
    },
    messages: [{ role: 'user', content: user }],
  });

  // Safety classifiers answer with a 200 and an empty content array, so this
  // has to be checked before reading content rather than caught as an error.
  if (message.stop_reason === 'refusal') {
    throw new ClaudeError(
      `Claude declined the request (${message.stop_details?.category ?? 'unknown'}).`,
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new ClaudeError('Claude hit the output limit before finishing the JSON.');
  }

  // Thinking blocks come first; the JSON is in the text block after them.
  const text = message.content.find((block) => block.type === 'text')?.text;
  if (!text) throw new ClaudeError('Claude returned no text content.');

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ClaudeError('Claude returned text that was not valid JSON.');
  }
}
