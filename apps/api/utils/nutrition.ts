import { createHash } from 'node:crypto';
import { fs } from '@/utils/firebase';
import type { Recipe } from '@/utils/types';
import {
  normalizeNutritionValues,
  type NutritionEstimate,
  type NutritionUnavailableReason,
} from '@fridgie/shared/nutrition';
import type { NutritionProvider } from './nutritionProvider';

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_ANALYSIS_BUDGET = 8;
const DEFAULT_ANALYSIS_CONCURRENCY = 2;

interface StoredNutritionCache {
  sourceHash?: unknown;
  estimate?: unknown;
}

export interface NutritionCache {
  getMany(recipeIds: string[]): Promise<Map<string, StoredNutritionCache>>;
  set(recipeId: string, entry: { sourceHash: string; estimate: NutritionEstimate }): Promise<void>;
}

export interface ResolvedNutrition {
  estimate: NutritionEstimate | null;
  reason?: NutritionUnavailableReason;
}

type RecipeForAnalysis = Pick<Recipe, 'id' | 'name' | 'ingredients' | 'servings'>;

/** Match the single-recipe API's owner-only boundary before any private recipe
 * text can enter the shared cache or leave Fridgie for a nutrition provider. */
export function canAnalyzeRecipeForUser(
  recipe: Pick<Recipe, 'visibility' | 'createdBy'>,
  uid: string,
): boolean {
  return recipe.visibility !== 'private' || recipe.createdBy === uid;
}

/**
 * Changing a title, serving count, ingredient name, amount or order invalidates
 * the estimate. Instructions do not: the configured provider receives the
 * ingredient lines, not the prose method.
 */
export function recipeNutritionFingerprint(recipe: RecipeForAnalysis): string {
  const input = JSON.stringify({
    schema: CACHE_SCHEMA_VERSION,
    name: String(recipe.name ?? '').trim(),
    servings: typeof recipe.servings === 'number' ? recipe.servings : null,
    ingredients: Array.isArray(recipe.ingredients)
      ? recipe.ingredients.map((item) => ({
          name: String(item?.name ?? '').trim(),
          quantity: String(item?.quantity ?? '').trim(),
        }))
      : [],
  });
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeNutritionEstimate(value: unknown): NutritionEstimate | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const values = normalizeNutritionValues(record.values);
  if (!values
    || record.isEstimate !== true
    || record.basis !== 'per-serving'
    || typeof record.provider !== 'string'
    || typeof record.providerLabel !== 'string'
    || typeof record.analyzedAt !== 'string'
    || !Number.isFinite(Date.parse(record.analyzedAt))) return null;
  return {
    isEstimate: true,
    basis: 'per-serving',
    values,
    provider: record.provider,
    providerLabel: record.providerLabel,
    analyzedAt: record.analyzedAt,
  };
}

export function firestoreNutritionCache(database: typeof fs = fs): NutritionCache {
  return {
    async getMany(recipeIds) {
      if (recipeIds.length === 0) return new Map();
      const refs = recipeIds.map((id) => database.collection('recipeNutrition').doc(id));
      const snapshots = await database.getAll(...refs);
      return new Map(snapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => [snapshot.id, snapshot.data() as StoredNutritionCache]));
    },
    async set(recipeId, entry) {
      await database.collection('recipeNutrition').doc(recipeId).set(entry);
    },
  };
}

function configuredInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

/**
 * Resolves cache hits first, then analyzes a bounded number of misses. One
 * weekly page load can therefore never turn an unexpectedly large plan into
 * an unbounded provider bill.
 */
export async function resolveRecipeNutrition(
  recipes: RecipeForAnalysis[],
  provider: NutritionProvider,
  cache: NutritionCache = firestoreNutritionCache(),
  options: { analysisBudget?: number; concurrency?: number } = {},
): Promise<Map<string, ResolvedNutrition>> {
  const unique = [...new Map(recipes.filter((recipe) => recipe?.id).map((recipe) => [recipe.id, recipe])).values()];
  const resolved = new Map<string, ResolvedNutrition>();
  if (unique.length === 0) return resolved;

  let cached: Map<string, StoredNutritionCache>;
  try {
    cached = await cache.getMany(unique.map((recipe) => recipe.id));
  } catch (error) {
    console.error('Nutrition cache read failed:', error instanceof Error ? error.message : 'unknown error');
    for (const recipe of unique) resolved.set(recipe.id, { estimate: null, reason: 'analysis-failed' });
    return resolved;
  }

  const misses: RecipeForAnalysis[] = [];
  for (const recipe of unique) {
    const fingerprint = recipeNutritionFingerprint(recipe);
    const entry = cached.get(recipe.id);
    const estimate = entry?.sourceHash === fingerprint
      ? normalizeNutritionEstimate(entry.estimate)
      : null;
    if (estimate) {
      resolved.set(recipe.id, { estimate });
      continue;
    }
    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0 || !String(recipe.name ?? '').trim()) {
      resolved.set(recipe.id, { estimate: null, reason: 'recipe-incomplete' });
      continue;
    }
    if (!provider.configured) {
      resolved.set(recipe.id, { estimate: null, reason: 'provider-not-configured' });
      continue;
    }
    misses.push(recipe);
  }

  const budget = options.analysisBudget ?? configuredInteger(
    process.env.NUTRITION_MAX_NEW_ANALYSES_PER_REQUEST,
    DEFAULT_ANALYSIS_BUDGET,
    30,
  );
  const concurrency = options.concurrency ?? configuredInteger(
    process.env.NUTRITION_ANALYSIS_CONCURRENCY,
    DEFAULT_ANALYSIS_CONCURRENCY,
    5,
  );
  const toAnalyze = misses.slice(0, Math.max(0, budget));
  for (const recipe of misses.slice(toAnalyze.length)) {
    resolved.set(recipe.id, { estimate: null, reason: 'analysis-pending' });
  }

  await mapWithConcurrency(toAnalyze, concurrency, async (recipe) => {
    try {
      const estimate = await provider.analyzeRecipe(recipe);
      if (!estimate) {
        resolved.set(recipe.id, { estimate: null, reason: 'analysis-failed' });
        return;
      }
      const normalized = normalizeNutritionEstimate(estimate);
      if (!normalized) {
        resolved.set(recipe.id, { estimate: null, reason: 'analysis-failed' });
        return;
      }
      resolved.set(recipe.id, { estimate: normalized });
      try {
        await cache.set(recipe.id, {
          sourceHash: recipeNutritionFingerprint(recipe),
          estimate: normalized,
        });
      } catch (error) {
        // The estimate is still useful for this response. Log only the cache
        // failure and never the recipe's private ingredient text.
        console.error('Nutrition cache write failed:', error instanceof Error ? error.message : 'unknown error');
      }
    } catch (error) {
      console.warn('Nutrition analysis failed:', error instanceof Error ? error.message : 'unknown error');
      resolved.set(recipe.id, { estimate: null, reason: 'analysis-failed' });
    }
  });

  return resolved;
}
