/**
 * Nutrition is deliberately kept separate from dietary safety.
 *
 * A calorie or macro target is a personal planning preference. Allergies and
 * dietary needs remain hard constraints on meal suggestions and never pass
 * through this module (or through a Pro gate).
 */

export const NUTRITION_METRICS = [
  'calories',
  'proteinGrams',
  'carbsGrams',
  'fatGrams',
  'fiberGrams',
] as const;

export type NutritionMetric = typeof NUTRITION_METRICS[number];

/** All values are for one serving. */
export type NutritionValues = Record<NutritionMetric, number>;

/** Daily goals. Calories and protein are the intentionally small first step. */
export interface NutritionGoals {
  calories: number;
  proteinGrams: number;
  carbsGrams?: number;
  fatGrams?: number;
  fiberGrams?: number;
}

export interface NutritionEstimate {
  /** Nutrition Analysis is an estimate, not a laboratory measurement. */
  isEstimate: true;
  basis: 'per-serving';
  values: NutritionValues;
  provider: string;
  providerLabel: string;
  analyzedAt: string;
}

export type NutritionUnavailableReason =
  | 'provider-not-configured'
  | 'recipe-not-found'
  | 'recipe-incomplete'
  | 'analysis-pending'
  | 'analysis-failed';

export interface WeeklyNutritionMeal {
  mealId: string;
  recipeId?: string;
  name: string;
  dayOfWeek?: string;
  consumed: boolean;
  nutrition: NutritionEstimate | null;
  unavailableReason?: NutritionUnavailableReason;
}

export interface NutritionSummary {
  totals: NutritionValues;
  analyzedMeals: number;
  totalMeals: number;
}

export interface WeeklyNutritionAnalysis {
  weekStart: string;
  goals: NutritionGoals | null;
  planned: NutritionSummary;
  consumed: NutritionSummary;
  meals: WeeklyNutritionMeal[];
  provider: {
    configured: boolean;
    id: string | null;
    label: string | null;
  };
}

/** Broad storage limits, not health recommendations. */
export const NUTRITION_GOAL_LIMITS: Record<NutritionMetric, { min: number; max: number }> = {
  calories: { min: 1, max: 20_000 },
  proteinGrams: { min: 1, max: 2_000 },
  carbsGrams: { min: 1, max: 2_000 },
  fatGrams: { min: 1, max: 1_000 },
  fiberGrams: { min: 1, max: 500 },
};

export const emptyNutrition = (): NutritionValues => ({
  calories: 0,
  proteinGrams: 0,
  carbsGrams: 0,
  fatGrams: 0,
  fiberGrams: 0,
});

const rounded = (value: number): number => Math.round(value * 10) / 10;

/**
 * Reject incomplete, negative, NaN or infinite provider data. A partially
 * present row is more dangerous than no row because the absent zero looks
 * precise in a weekly total.
 */
export function normalizeNutritionValues(value: unknown): NutritionValues | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const normalized = emptyNutrition();
  for (const metric of NUTRITION_METRICS) {
    const candidate = record[metric];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) return null;
    normalized[metric] = rounded(candidate);
  }
  return normalized;
}

export type NutritionGoalsValidation =
  | { ok: true; goals: NutritionGoals }
  | { ok: false; field?: NutritionMetric; message: string };

/** Strict at the wire: callers must send JSON numbers, never numeric strings. */
export function validateNutritionGoals(value: unknown): NutritionGoalsValidation {
  if (!value || typeof value !== 'object') {
    return { ok: false, message: 'Nutrition goals must be an object.' };
  }
  const record = value as Record<string, unknown>;
  const goals: Partial<NutritionGoals> = {};

  for (const metric of NUTRITION_METRICS) {
    const candidate = record[metric];
    const required = metric === 'calories' || metric === 'proteinGrams';
    if (candidate === undefined || candidate === null || candidate === '') {
      if (required) return { ok: false, field: metric, message: `${metric} is required.` };
      continue;
    }
    const limits = NUTRITION_GOAL_LIMITS[metric];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)
      || candidate < limits.min || candidate > limits.max) {
      return {
        ok: false,
        field: metric,
        message: `${metric} must be between ${limits.min} and ${limits.max}.`,
      };
    }
    goals[metric] = rounded(candidate);
  }

  return { ok: true, goals: goals as NutritionGoals };
}

/** One planned meal represents one serving for the signed-in person's view. */
export function aggregateWeeklyNutrition(meals: WeeklyNutritionMeal[]): {
  planned: NutritionSummary;
  consumed: NutritionSummary;
} {
  const planned: NutritionSummary = { totals: emptyNutrition(), analyzedMeals: 0, totalMeals: meals.length };
  const consumedMeals = meals.filter((meal) => meal.consumed);
  const consumed: NutritionSummary = { totals: emptyNutrition(), analyzedMeals: 0, totalMeals: consumedMeals.length };

  for (const meal of meals) {
    const values = normalizeNutritionValues(meal.nutrition?.values);
    if (!values) continue;
    planned.analyzedMeals += 1;
    for (const metric of NUTRITION_METRICS) planned.totals[metric] += values[metric];
    if (meal.consumed) {
      consumed.analyzedMeals += 1;
      for (const metric of NUTRITION_METRICS) consumed.totals[metric] += values[metric];
    }
  }

  for (const metric of NUTRITION_METRICS) {
    planned.totals[metric] = rounded(planned.totals[metric]);
    consumed.totals[metric] = rounded(consumed.totals[metric]);
  }
  return { planned, consumed };
}

/** Daily goals expressed over a week; optional goals remain optional. */
export function weeklyNutritionGoals(goals: NutritionGoals, days = 7): Partial<NutritionValues> {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 7;
  const result: Partial<NutritionValues> = {};
  for (const metric of NUTRITION_METRICS) {
    const value = goals[metric];
    if (typeof value === 'number' && Number.isFinite(value)) result[metric] = rounded(value * safeDays);
  }
  return result;
}

/** Ratios are intentionally not clamped: exceeding a goal is useful context. */
export function nutritionGoalProgress(
  totals: NutritionValues,
  goals: NutritionGoals,
  days = 7,
): Partial<Record<NutritionMetric, number>> {
  const week = weeklyNutritionGoals(goals, days);
  const progress: Partial<Record<NutritionMetric, number>> = {};
  for (const metric of NUTRITION_METRICS) {
    const target = week[metric];
    if (typeof target === 'number' && target > 0) progress[metric] = totals[metric] / target;
  }
  return progress;
}
