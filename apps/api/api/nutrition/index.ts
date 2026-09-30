import { Hono } from 'hono';
import { FieldValue } from 'firebase-admin/firestore';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { requireAccount } from '@/middleware/requireAccount';
import { requirePro } from '@/middleware/requirePro';
import { adminRtdb, fs } from '@/utils/firebase';
import { canAnalyzeRecipeForUser, resolveRecipeNutrition } from '@/utils/nutrition';
import { nutritionProviderFromEnv } from '@/utils/nutritionProvider';
import type { Meal, Recipe } from '@/utils/types';
import {
  aggregateWeeklyNutrition,
  validateNutritionGoals,
  type NutritionGoals,
  type WeeklyNutritionAnalysis,
  type WeeklyNutritionMeal,
} from '@fridgie/shared/nutrition';

const route = new Hono();
const provider = nutritionProviderFromEnv();
const MAX_MEALS_PER_WEEK = 50;

route.use('*', auth, requireAccount, requirePro);

const goalsRef = (uid: string) =>
  fs.collection('users').doc(uid).collection('settings').doc('nutrition');

async function readGoals(uid: string): Promise<NutritionGoals | null> {
  const snapshot = await goalsRef(uid).get();
  if (!snapshot.exists) return null;
  const validation = validateNutritionGoals(snapshot.data()?.goals);
  return validation.ok ? validation.goals : null;
}

/** Pro-only, but intentionally independent of dietary/allergen preferences. */
route.get('/goals', async (c) => {
  const goals = await readGoals(c.get('uid'));
  return c.json({ goals });
});

route.put('/goals', async (c) => {
  const body = await c.req.json<{ goals?: unknown }>().catch(() => null);
  const validation = validateNutritionGoals(body?.goals);
  if (!validation.ok) {
    return c.json({ error: 'invalid_nutrition_goals', field: validation.field, message: validation.message }, 400);
  }
  await goalsRef(c.get('uid')).set({
    goals: validation.goals,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return c.json({ goals: validation.goals });
});

// These paths name group-owned list data, so Pro alone is not authorization.
route.use('/weekly', groupAuth);
route.use('/consumed', groupAuth);

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return Object.values(value) as T[];
  return [];
}

const validDocumentId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 1_500
  && value !== '.'
  && value !== '..'
  && !value.includes('/');

route.get('/weekly', async (c) => {
  const uid = c.get('uid');
  const groupId = c.req.query('groupId');
  const listId = c.req.query('listId');
  if (!groupId || !listId) return c.json({ error: 'Missing groupId or listId' }, 400);

  const listSnapshot = await adminRtdb.ref(`lists/${groupId}/${listId}`).once('value');
  const list = listSnapshot.val();
  if (!list) return c.json({ error: 'List not found' }, 404);

  const storedMeals = asArray<Meal>(list.meals).slice(0, MAX_MEALS_PER_WEEK);
  const recipeIds = [...new Set(storedMeals
    .map((meal) => meal?.recipeId)
    .filter(validDocumentId))];
  const recipeRefs = recipeIds.map((id) => fs.collection('recipes').doc(id));
  const consumedRefs = storedMeals
    .filter((meal) => validDocumentId(meal?.id))
    .map((meal) => fs.collection('users').doc(uid).collection('nutritionConsumedMeals').doc(meal.id));

  const [recipeSnapshots, consumedSnapshots, goals] = await Promise.all([
    recipeRefs.length ? fs.getAll(...recipeRefs) : Promise.resolve([]),
    consumedRefs.length ? fs.getAll(...consumedRefs) : Promise.resolve([]),
    readGoals(uid),
  ]);
  const recipes = new Map<string, Recipe>(recipeSnapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => [snapshot.id, { id: snapshot.id, ...snapshot.data() } as Recipe] as const)
    .filter(([, recipe]) => canAnalyzeRecipeForUser(recipe, uid)));
  const consumedIds = new Set(consumedSnapshots
    .filter((snapshot) => snapshot.exists
      && snapshot.data()?.consumed !== false
      && snapshot.data()?.groupId === groupId
      && snapshot.data()?.listId === listId)
    .map((snapshot) => snapshot.id));
  const resolved = await resolveRecipeNutrition([...recipes.values()], provider);

  const meals: WeeklyNutritionMeal[] = storedMeals
    .filter((meal) => typeof meal?.id === 'string' && meal.id.length > 0)
    .map((meal) => {
      const recipeId = typeof meal.recipeId === 'string' ? meal.recipeId : undefined;
      const recipe = recipeId ? recipes.get(recipeId) : undefined;
      const nutrition = recipeId ? resolved.get(recipeId) : undefined;
      return {
        mealId: meal.id,
        ...(recipeId ? { recipeId } : {}),
        name: typeof meal.name === 'string' && meal.name.trim() ? meal.name.trim() : 'Untitled meal',
        ...(typeof meal.dayOfWeek === 'string' ? { dayOfWeek: meal.dayOfWeek } : {}),
        consumed: consumedIds.has(meal.id),
        nutrition: nutrition?.estimate ?? null,
        ...(!recipe ? { unavailableReason: 'recipe-not-found' as const }
          : nutrition?.reason ? { unavailableReason: nutrition.reason } : {}),
      };
    });
  const summaries = aggregateWeeklyNutrition(meals);
  const response: WeeklyNutritionAnalysis = {
    weekStart: String(list.weekStart ?? '').slice(0, 10),
    goals,
    ...summaries,
    meals,
    provider: {
      configured: provider.configured,
      id: provider.id,
      label: provider.label,
    },
  };
  return c.json(response);
});

/** Marks a meal cooked (or unmarks it); this is not a medical food log. */
route.post('/consumed', async (c) => {
  const uid = c.get('uid');
  const groupId = c.req.query('groupId');
  const listId = c.req.query('listId');
  const body = await c.req.json<{ mealId?: unknown; consumed?: unknown }>().catch(() => null);
  const mealId = typeof body?.mealId === 'string' ? body.mealId : '';
  if (!groupId || !listId || !validDocumentId(mealId) || typeof body?.consumed !== 'boolean') {
    return c.json({ error: 'Missing or invalid groupId, listId, mealId, or consumed value' }, 400);
  }

  const listSnapshot = await adminRtdb.ref(`lists/${groupId}/${listId}`).once('value');
  const list = listSnapshot.val();
  if (!list) return c.json({ error: 'List not found' }, 404);
  const meal = asArray<Meal>(list.meals).find((candidate) => candidate?.id === mealId);
  if (!meal) return c.json({ error: 'Meal not found in this list' }, 404);

  const ref = fs.collection('users').doc(uid).collection('nutritionConsumedMeals').doc(mealId);
  if (!body.consumed) {
    await ref.delete();
    return c.json({ mealId, consumed: false });
  }
  await ref.set({
    mealId,
    groupId,
    listId,
    ...(meal.recipeId ? { recipeId: meal.recipeId } : {}),
    consumed: true,
    consumedAt: FieldValue.serverTimestamp(),
  });
  return c.json({ mealId, consumed: true });
});

export default route;
