import type { Context } from 'hono';
import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import { requirePro } from '@/middleware/requirePro';
import { fs } from '@/utils/firebase';
import {
  completeRecipeChatUse,
  consumeRecipeChatAttempt,
  ProQuotaAccessError,
  refundRecipeChatUse,
  reserveRecipeChatUse,
} from '@/utils/aiQuota';
import {
  retryAfterSeconds,
  type AttemptRateDecision,
  type QuotaReservation,
} from '@/utils/aiQuotaCore';
import { completeJson, models } from '@/utils/claude';
import {
  normalizeProposal,
  parseRecipeChatRequest,
  recipeChatSchema,
  recipeChatSystemPrompt,
  toMessageHistory,
  type ChatRecipe,
  type ModelChatAnswer,
} from '@/utils/recipeChat';

export interface StoredChatRecipe extends ChatRecipe {
  createdBy?: string;
  visibility?: string;
}

interface AskDependencies {
  completeJson: typeof completeJson;
  loadRecipe: (id: string) => Promise<StoredChatRecipe | null>;
  loadDietaryContext: (uid: string) => Promise<string[]>;
  reserveChat: (uid: string) => Promise<QuotaReservation>;
  consumeAttempt: (uid: string) => Promise<AttemptRateDecision>;
  completeChat: (uid: string, reservationId: string) => Promise<boolean>;
  refundChat: (uid: string, reservationId: string) => Promise<boolean>;
}

/**
 * POST /api/recipe/ask/:id
 * Body: { messages: [{ role, content }...], viewingServings?: number }
 *
 * Answers a question about one recipe, and — only on a recipe the caller owns —
 * may return a proposed replacement for the cook to accept. Applying it is an
 * ordinary save through POST /api/recipe, made by the app after the cook taps
 * Apply; this route never writes the recipe.
 */
export function createAskRecipeHandler(dependencies: AskDependencies) {
  return async (c: Context) => {
    const uid = c.get('uid') as string;
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'missing_recipe', message: 'Missing recipe ID.' }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'That message could not be read.' }, 400);
    }

    const parsed = parseRecipeChatRequest(body);
    if ('error' in parsed) return c.json({ error: 'invalid_messages', message: parsed.error }, 400);

    let recipe: StoredChatRecipe | null;
    try {
      recipe = await dependencies.loadRecipe(id);
    } catch (error) {
      console.error('Could not load recipe for Ask Fridgie:', error instanceof Error ? error.message : error);
      return c.json({ error: 'recipe_unavailable', message: 'Could not load this recipe right now.' }, 503);
    }
    // A private recipe is invisible to everyone but its owner, here as on GET.
    if (!recipe || (recipe.visibility === 'private' && recipe.createdBy !== uid)) {
      return c.json({ error: 'recipe_not_found', message: 'Recipe not found.' }, 404);
    }

    // The one decision that matters, made from the stored document: only the
    // owner of THIS recipe gets edit proposals. Someone else's recipe is never
    // offered one, even though saving it would fork rather than overwrite.
    const canEdit = !!recipe.createdBy && recipe.createdBy === uid;

    // Best-effort, as on /recipe/generate: a preferences read that fails costs
    // a less personal answer, not the answer.
    const dietaryContext = await dependencies.loadDietaryContext(uid).catch(() => [] as string[]);

    let reservation: QuotaReservation;
    try {
      reservation = await dependencies.reserveChat(uid);
    } catch (error) {
      if (error instanceof ProQuotaAccessError) {
        return error.code === 'pro_required'
          ? c.json({ error: 'pro_required', message: 'Ask Fridgie is included with Fridgie Pro.' }, 403)
          : c.json({ error: 'entitlement_unavailable', message: 'Could not verify Fridgie Pro right now.' }, 503);
      }
      console.error('Could not reserve an Ask Fridgie message:', error instanceof Error ? error.name : 'unknown');
      return c.json({ error: 'recipe_chat_unavailable', message: 'Fridgie is unavailable right now. Please try again.' }, 503);
    }

    if (!reservation.accepted || !reservation.reservationId) {
      return c.json({
        error: 'recipe_chat_limit',
        message: 'You have used this week’s Ask Fridgie allowance. It resets automatically.',
        chatUsage: reservation.usage,
      }, 429);
    }
    const reservationId = reservation.reservationId;
    const refund = (why: string) => dependencies.refundChat(uid, reservationId).catch((refundError) => {
      console.error(`Could not refund ${why} Ask Fridgie message:`, refundError instanceof Error ? refundError.name : 'unknown');
    });

    let attempt: AttemptRateDecision;
    try {
      attempt = await dependencies.consumeAttempt(uid);
    } catch (error) {
      await refund('an unattempted');
      console.error('Could not reserve an Ask Fridgie provider attempt:', error instanceof Error ? error.name : 'unknown');
      return c.json({ error: 'recipe_chat_unavailable', message: 'Fridgie is unavailable right now. Please try again.' }, 503);
    }
    if (!attempt.accepted) {
      await refund('a rate-limited');
      c.header('Retry-After', String(retryAfterSeconds(attempt.usage)));
      return c.json({
        error: 'recipe_chat_rate_exceeded',
        message: 'That’s a lot of questions at once. Give Fridgie a few minutes and try again.',
      }, 429);
    }

    try {
      const answer = await dependencies.completeJson<ModelChatAnswer>({
        model: models.recipeChat,
        system: recipeChatSystemPrompt({
          recipe,
          canEdit,
          viewingServings: parsed.viewingServings,
          dietaryContext,
        }),
        history: toMessageHistory(parsed.history),
        user: parsed.question,
        schema: recipeChatSchema(canEdit),
        effort: 'low',
        maxTokens: 8000,
        timeoutMs: 90_000,
        maxRetries: 0,
      });

      const reply = typeof answer?.reply === 'string' ? answer.reply.trim() : '';
      if (!reply) {
        await refund('an empty');
        return c.json({ error: 'recipe_chat_failed', message: 'Fridgie didn’t have an answer for that. Try asking another way.' }, 502);
      }

      await dependencies.completeChat(uid, reservationId).catch((completeError) => {
        console.error('Could not finalize an Ask Fridgie message:', completeError instanceof Error ? completeError.name : 'unknown');
      });

      return c.json({
        reply,
        proposal: canEdit ? normalizeProposal(answer.proposal, recipe) : null,
        canEdit,
        chatUsage: reservation.usage,
      });
    } catch (error) {
      await refund('a failed');
      console.error('Ask Fridgie failed:', error instanceof Error ? error.name : 'unknown error');
      return c.json({ error: 'recipe_chat_failed', message: 'Fridgie couldn’t answer just now. Please try again.' }, 500);
    }
  };
}

async function loadRecipe(id: string): Promise<StoredChatRecipe | null> {
  const snapshot = await fs.collection('recipes').doc(id).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() ?? {};
  return {
    name: typeof data.name === 'string' ? data.name : 'Untitled recipe',
    description: typeof data.description === 'string' ? data.description : '',
    ingredients: Array.isArray(data.ingredients)
      ? data.ingredients.map((ing: any) => ({ name: String(ing?.name ?? ''), quantity: String(ing?.quantity ?? '') }))
      : [],
    instructions: Array.isArray(data.instructions) ? data.instructions.map(String) : [],
    servings: typeof data.servings === 'number' ? data.servings : null,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : undefined,
    visibility: typeof data.visibility === 'string' ? data.visibility : undefined,
  };
}

/** Diet and dislikes only — the same constraints /recipe/generate honours. */
async function loadDietaryContext(uid: string): Promise<string[]> {
  const snapshot = await fs.collection('users').doc(uid).get();
  const preferences = snapshot.data()?.preferences as
    | { dietaryNeeds?: unknown; dislikedIngredients?: unknown }
    | undefined;
  if (!preferences) return [];

  const lines: string[] = [];
  const needs = Array.isArray(preferences.dietaryNeeds)
    ? preferences.dietaryNeeds.filter((need): need is string => typeof need === 'string')
    : [];
  if (needs.length) {
    lines.push(`Their saved dietary needs: ${needs.join(', ')}. Keep every suggestion and proposed edit within them.`);
  }
  const disliked = Array.isArray(preferences.dislikedIngredients)
    ? preferences.dislikedIngredients.filter((item): item is string => typeof item === 'string').join(', ')
    : typeof preferences.dislikedIngredients === 'string' ? preferences.dislikedIngredients : '';
  if (disliked.trim()) lines.push(`Ingredients they dislike: ${disliked.trim()}. Don't suggest them as substitutes.`);
  return lines;
}

const route = new Hono();
route.use('*', auth, requireAccount, requirePro);
route.post('/', createAskRecipeHandler({
  completeJson,
  loadRecipe,
  loadDietaryContext,
  reserveChat: reserveRecipeChatUse,
  consumeAttempt: consumeRecipeChatAttempt,
  completeChat: completeRecipeChatUse,
  refundChat: refundRecipeChatUse,
}));

export default route;
