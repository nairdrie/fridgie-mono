import type { Ingredient } from '@/utils/types';
import {
  normalizeNutritionValues,
  type NutritionEstimate,
  type NutritionValues,
} from '@fridgie/shared/nutrition';

export interface NutritionRecipeInput {
  name: string;
  ingredients: Ingredient[];
  servings?: number;
}

export interface NutritionProvider {
  readonly id: string | null;
  readonly label: string | null;
  readonly configured: boolean;
  analyzeRecipe(recipe: NutritionRecipeInput): Promise<NutritionEstimate | null>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface EdamamNutrient {
  quantity?: number;
}

interface EdamamResponse {
  yield?: number;
  calories?: number;
  totalNutrients?: Record<string, EdamamNutrient | undefined>;
}

export class NutritionProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'NutritionProviderError';
  }
}

const unavailableProvider: NutritionProvider = {
  id: null,
  label: null,
  configured: false,
  async analyzeRecipe() { return null; },
};

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nutrient(response: EdamamResponse, key: string): number | null {
  const value = response.totalNutrients?.[key]?.quantity;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Edamam analyzes the complete recipe text, including ordinary measures such
 * as "1 medium onion" that cannot be responsibly converted to grams locally.
 * Values returned by the provider are recipe totals, divided by its resolved
 * yield so every cached estimate has one unambiguous per-serving basis.
 */
export function createEdamamNutritionProvider(
  appId: string,
  appKey: string,
  fetchImpl: FetchLike = fetch,
): NutritionProvider {
  return {
    id: 'edamam',
    label: 'Edamam',
    configured: true,
    async analyzeRecipe(recipe) {
      const ingredients = recipe.ingredients
        .filter((item) => typeof item?.name === 'string' && item.name.trim())
        .slice(0, 100)
        .map((item) => `${String(item.quantity ?? '').trim()} ${item.name.trim()}`.trim());
      if (!recipe.name.trim() || ingredients.length === 0) return null;

      const url = new URL('https://api.edamam.com/api/nutrition-details');
      url.searchParams.set('app_id', appId);
      url.searchParams.set('app_key', appKey);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: recipe.name.slice(0, 300),
            ingr: ingredients,
            ...(positive(recipe.servings) ? { yield: `${recipe.servings} servings` } : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'AbortError';
        throw new NutritionProviderError(timedOut ? 'Nutrition analysis timed out.' : 'Nutrition provider could not be reached.');
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // Do not include the response body: providers sometimes echo request
        // metadata, and credentials are present in this request's URL.
        throw new NutritionProviderError('Nutrition provider rejected the analysis.', response.status);
      }

      let body: EdamamResponse;
      try {
        body = await response.json() as EdamamResponse;
      } catch {
        throw new NutritionProviderError('Nutrition provider returned an invalid response.');
      }

      const servings = positive(body.yield) ?? positive(recipe.servings);
      if (!servings) return null;

      const totalCalories = nutrient(body, 'ENERC_KCAL') ?? (
        typeof body.calories === 'number' && Number.isFinite(body.calories) && body.calories >= 0
          ? body.calories
          : null
      );
      const totals = {
        calories: totalCalories,
        proteinGrams: nutrient(body, 'PROCNT'),
        carbsGrams: nutrient(body, 'CHOCDF'),
        fatGrams: nutrient(body, 'FAT'),
        fiberGrams: nutrient(body, 'FIBTG'),
      };
      if (Object.values(totals).some((value) => value === null)) return null;

      const perServing = Object.fromEntries(
        Object.entries(totals).map(([key, value]) => [key, (value as number) / servings]),
      ) as NutritionValues;
      const values = normalizeNutritionValues(perServing);
      if (!values) return null;

      return {
        isEstimate: true,
        basis: 'per-serving',
        values,
        provider: 'edamam',
        providerLabel: 'Edamam',
        analyzedAt: new Date().toISOString(),
      };
    },
  };
}

/** Resolve once at module load in production; dependency-inject in tests. */
export function nutritionProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchLike = fetch,
): NutritionProvider {
  // Credentials may be provisioned before legal/licensing review is complete.
  // Keep outbound analysis fail-closed until an operator explicitly opts in.
  const enabled = env.NUTRITION_PROVIDER_ENABLED?.trim().toLowerCase() === 'true';
  const appId = env.EDAMAM_NUTRITION_APP_ID?.trim();
  const appKey = env.EDAMAM_NUTRITION_APP_KEY?.trim();
  if (!enabled || !appId || !appKey) return unavailableProvider;
  return createEdamamNutritionProvider(appId, appKey, fetchImpl);
}
