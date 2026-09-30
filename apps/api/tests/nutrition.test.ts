import { describe, expect, mock, test } from 'bun:test';
import {
  aggregateWeeklyNutrition,
  nutritionGoalProgress,
  validateNutritionGoals,
  weeklyNutritionGoals,
  type NutritionEstimate,
  type WeeklyNutritionMeal,
} from '@fridgie/shared/nutrition';
import {
  canAnalyzeRecipeForUser,
  recipeNutritionFingerprint,
  resolveRecipeNutrition,
  type NutritionCache,
} from '../utils/nutrition';
import {
  createEdamamNutritionProvider,
  nutritionProviderFromEnv,
  type NutritionProvider,
} from '../utils/nutritionProvider';

const estimate = (calories: number, proteinGrams = 20): NutritionEstimate => ({
  isEstimate: true,
  basis: 'per-serving',
  values: { calories, proteinGrams, carbsGrams: 30, fatGrams: 10, fiberGrams: 5 },
  provider: 'fixture',
  providerLabel: 'Fixture Foods',
  analyzedAt: '2026-09-29T12:00:00.000Z',
});

const meal = (id: string, calories: number | null, consumed = false): WeeklyNutritionMeal => ({
  mealId: id,
  recipeId: `recipe-${id}`,
  name: `Meal ${id}`,
  consumed,
  nutrition: calories === null ? null : estimate(calories),
});

describe('nutrition goals and weekly aggregation', () => {
  test('requires numeric calorie and protein goals without requiring optional macros', () => {
    expect(validateNutritionGoals({ calories: 2_000, proteinGrams: 120 })).toEqual({
      ok: true,
      goals: { calories: 2_000, proteinGrams: 120 },
    });
    expect(validateNutritionGoals({ calories: '2000', proteinGrams: 120 })).toMatchObject({ ok: false, field: 'calories' });
    expect(validateNutritionGoals({ calories: 2_000 })).toMatchObject({ ok: false, field: 'proteinGrams' });
    expect(validateNutritionGoals({ calories: 2_000, proteinGrams: 120, fiberGrams: -1 })).toMatchObject({ ok: false, field: 'fiberGrams' });
  });

  test('counts only analyzed meals and separates planned from consumed totals', () => {
    const result = aggregateWeeklyNutrition([
      meal('a', 500, true),
      meal('b', 650, false),
      meal('c', null, true),
    ]);
    expect(result.planned.totalMeals).toBe(3);
    expect(result.planned.analyzedMeals).toBe(2);
    expect(result.planned.totals.calories).toBe(1_150);
    expect(result.planned.totals.proteinGrams).toBe(40);
    expect(result.consumed.totalMeals).toBe(2);
    expect(result.consumed.analyzedMeals).toBe(1);
    expect(result.consumed.totals.calories).toBe(500);
  });

  test('compares meal totals with seven daily goals without hiding overages', () => {
    const goals = { calories: 2_000, proteinGrams: 100, fiberGrams: 25 };
    expect(weeklyNutritionGoals(goals)).toEqual({ calories: 14_000, proteinGrams: 700, fiberGrams: 175 });
    expect(nutritionGoalProgress({ calories: 15_400, proteinGrams: 350, carbsGrams: 0, fatGrams: 0, fiberGrams: 175 }, goals)).toEqual({
      calories: 1.1,
      proteinGrams: 0.5,
      fiberGrams: 1,
    });
  });
});

function memoryCache(seed: Record<string, any> = {}): NutritionCache & { entries: Map<string, any> } {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    async getMany(ids) { return new Map(ids.filter((id) => entries.has(id)).map((id) => [id, entries.get(id)])); },
    async set(id, value) { entries.set(id, structuredClone(value)); },
  };
}

const recipe = (id: string, quantity = '1 can') => ({
  id,
  name: 'Lemon chickpeas',
  servings: 2,
  ingredients: [{ name: 'chickpeas', quantity }, { name: 'lemon juice', quantity: '2 tbsp' }],
});

describe('nutrition estimate cache', () => {
  test('never analyzes another user\'s private recipe', () => {
    expect(canAnalyzeRecipeForUser({ visibility: 'private', createdBy: 'owner' }, 'collaborator')).toBe(false);
    expect(canAnalyzeRecipeForUser({ visibility: 'private', createdBy: 'owner' }, 'owner')).toBe(true);
    expect(canAnalyzeRecipeForUser({ visibility: 'public', createdBy: 'owner' }, 'collaborator')).toBe(true);
  });

  test('reuses a matching cached estimate without calling the provider', async () => {
    const item = recipe('one');
    const cache = memoryCache({ one: { sourceHash: recipeNutritionFingerprint(item), estimate: estimate(420) } });
    const analyzeRecipe = mock(async () => estimate(999));
    const provider: NutritionProvider = { id: 'fixture', label: 'Fixture', configured: true, analyzeRecipe };

    const result = await resolveRecipeNutrition([item], provider, cache);
    expect(result.get('one')?.estimate?.values.calories).toBe(420);
    expect(analyzeRecipe).not.toHaveBeenCalled();
  });

  test('invalidates on ingredient changes, stores the replacement, and deduplicates recipe ids', async () => {
    const old = recipe('one', '1 can');
    const current = recipe('one', '2 cans');
    const cache = memoryCache({ one: { sourceHash: recipeNutritionFingerprint(old), estimate: estimate(420) } });
    const analyzeRecipe = mock(async () => estimate(610));
    const provider: NutritionProvider = { id: 'fixture', label: 'Fixture', configured: true, analyzeRecipe };

    const result = await resolveRecipeNutrition([current, current], provider, cache);
    expect(result.get('one')?.estimate?.values.calories).toBe(610);
    expect(analyzeRecipe).toHaveBeenCalledTimes(1);
    expect(cache.entries.get('one').sourceHash).toBe(recipeNutritionFingerprint(current));
  });

  test('bounds new analyses and identifies work left for a later refresh', async () => {
    const cache = memoryCache();
    const analyzeRecipe = mock(async () => estimate(300));
    const provider: NutritionProvider = { id: 'fixture', label: 'Fixture', configured: true, analyzeRecipe };
    const result = await resolveRecipeNutrition(
      [recipe('one'), recipe('two'), recipe('three')],
      provider,
      cache,
      { analysisBudget: 2, concurrency: 1 },
    );
    expect(analyzeRecipe).toHaveBeenCalledTimes(2);
    expect(result.get('three')).toEqual({ estimate: null, reason: 'analysis-pending' });
  });

  test('does not attempt external analysis when credentials are absent', async () => {
    const analyzeRecipe = mock(async () => estimate(300));
    const provider: NutritionProvider = { id: null, label: null, configured: false, analyzeRecipe };
    const result = await resolveRecipeNutrition([recipe('one')], provider, memoryCache());
    expect(result.get('one')).toEqual({ estimate: null, reason: 'provider-not-configured' });
    expect(analyzeRecipe).not.toHaveBeenCalled();
  });
});

test('Edamam adapter submits recipe lines and converts recipe totals to one serving', async () => {
  const requests: { url: URL; body: any }[] = [];
  const provider = createEdamamNutritionProvider('app-id', 'secret-key', async (input, init) => {
    requests.push({ url: new URL(String(input)), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({
      yield: 2,
      calories: 1_000,
      totalNutrients: {
        ENERC_KCAL: { quantity: 1_000 },
        PROCNT: { quantity: 60 },
        CHOCDF: { quantity: 120 },
        FAT: { quantity: 40 },
        FIBTG: { quantity: 20 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await provider.analyzeRecipe(recipe('one'));
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.pathname).toBe('/api/nutrition-details');
  expect(requests[0]!.url.searchParams.get('app_id')).toBe('app-id');
  expect(requests[0]!.body).toMatchObject({
    title: 'Lemon chickpeas',
    yield: '2 servings',
    ingr: ['1 can chickpeas', '2 tbsp lemon juice'],
  });
  expect(result?.values).toEqual({
    calories: 500,
    proteinGrams: 30,
    carbsGrams: 60,
    fatGrams: 20,
    fiberGrams: 10,
  });
});

describe('nutrition provider launch gate', () => {
  test('credentials alone remain disabled until the operator explicitly opts in', () => {
    expect(nutritionProviderFromEnv({
      EDAMAM_NUTRITION_APP_ID: 'app-id',
      EDAMAM_NUTRITION_APP_KEY: 'secret-key',
    }).configured).toBe(false);
    expect(nutritionProviderFromEnv({
      NUTRITION_PROVIDER_ENABLED: 'false',
      EDAMAM_NUTRITION_APP_ID: 'app-id',
      EDAMAM_NUTRITION_APP_KEY: 'secret-key',
    }).configured).toBe(false);
  });

  test('requires both explicit enablement and complete credentials', () => {
    expect(nutritionProviderFromEnv({ NUTRITION_PROVIDER_ENABLED: 'true' }).configured).toBe(false);
    expect(nutritionProviderFromEnv({
      NUTRITION_PROVIDER_ENABLED: 'true',
      EDAMAM_NUTRITION_APP_ID: 'app-id',
      EDAMAM_NUTRITION_APP_KEY: 'secret-key',
    })).toMatchObject({ configured: true, id: 'edamam', label: 'Edamam' });
  });
});
