export type AccountPlan = 'free' | 'pro';

export interface AiPlan {
  id: AccountPlan;
  weeklyAiLimit: number;
  weeklyLeftoversScanLimit: number;
}

/**
 * Meal suggestions currently use Claude Sonnet and return three complete
 * recipes. 100 generations/week is meaningfully higher than the free tier
 * while still putting a predictable ceiling around the most expensive
 * interactive route. Keep these defaults in one place; production can lower
 * or raise them without changing the API or mobile release.
 */
export const DEFAULT_WEEKLY_AI_LIMITS: Readonly<Record<AccountPlan, number>> = Object.freeze({
  free: 10,
  pro: 100,
});

export const DEFAULT_WEEKLY_LEFTOVERS_SCAN_LIMIT = 50;

/**
 * These are deliberately separate from the user-facing weekly allowances.
 * Successful or failed provider dispatches both consume an attempt, so a
 * repeated refusal/invalid-image loop cannot turn refunds into unbounded spend.
 * The defaults leave ample room for ordinary retry and re-roll behavior.
 */
export const DEFAULT_HOURLY_AI_ATTEMPT_LIMITS = Object.freeze({
  mealSuggestions: 20,
  leftoversScans: 8,
});

const integerInRange = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

export function aiPlans(env: NodeJS.ProcessEnv = process.env): Readonly<Record<AccountPlan, AiPlan>> {
  // Product policy promises that free accounts get at most ten. The override
  // is useful for staged rollouts, but deliberately cannot raise that ceiling.
  const free = integerInRange(env.FRIDGIE_FREE_WEEKLY_AI_LIMIT, DEFAULT_WEEKLY_AI_LIMITS.free, 1, 10);
  const pro = integerInRange(env.FRIDGIE_PRO_WEEKLY_AI_LIMIT, DEFAULT_WEEKLY_AI_LIMITS.pro, 11, 10_000);
  const proLeftoversScans = integerInRange(
    env.FRIDGIE_PRO_WEEKLY_LEFTOVERS_SCAN_LIMIT,
    DEFAULT_WEEKLY_LEFTOVERS_SCAN_LIMIT,
    1,
    1_000,
  );
  return Object.freeze({
    free: Object.freeze({ id: 'free' as const, weeklyAiLimit: free, weeklyLeftoversScanLimit: 0 }),
    pro: Object.freeze({ id: 'pro' as const, weeklyAiLimit: pro, weeklyLeftoversScanLimit: proLeftoversScans }),
  });
}

export function maxConcurrentLeftoversScans(env: NodeJS.ProcessEnv = process.env): number {
  return integerInRange(env.FRIDGIE_MAX_CONCURRENT_LEFTOVERS_SCANS, 1, 1, 5);
}

export function hourlyAiAttemptLimits(env: NodeJS.ProcessEnv = process.env): {
  mealSuggestions: number;
  leftoversScans: number;
} {
  return Object.freeze({
    mealSuggestions: integerInRange(
      env.FRIDGIE_SUGGEST_HOURLY_ATTEMPT_LIMIT,
      DEFAULT_HOURLY_AI_ATTEMPT_LIMITS.mealSuggestions,
      1,
      500,
    ),
    leftoversScans: integerInRange(
      env.FRIDGIE_LEFTOVERS_HOURLY_ATTEMPT_LIMIT,
      DEFAULT_HOURLY_AI_ATTEMPT_LIMITS.leftoversScans,
      1,
      100,
    ),
  });
}

export interface AiUsageWindow {
  id: string;
  startsAt: string;
  endsAt: string;
}

/** Calendar week in UTC: Monday 00:00 through the following Monday 00:00. */
export function weeklyAiWindow(at: Date = new Date()): AiUsageWindow {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new TypeError('A valid date is required.');

  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);

  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    id: start.toISOString().slice(0, 10),
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  };
}

/** Fixed UTC clock-hour used only for non-refundable provider-attempt limits. */
export function hourlyAiAttemptWindow(at: Date = new Date()): AiUsageWindow {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new TypeError('A valid date is required.');

  const start = new Date(date);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    id: start.toISOString().slice(0, 13),
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  };
}
