import { fromZonedTime } from 'date-fns-tz'
import { localWeekKeys } from '@/utils/weekLists'

/** The zone "this week" is computed in when the app didn't say. */
export const DEFAULT_TIMEZONE = 'America/Toronto'

/** How far from the current week a tool may reach, in weeks. */
const WEEKS_BACK = 4
const WEEKS_AHEAD = 26

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const dayNumber = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!) / 86_400_000
}

export type ResolvedWeek =
  | { ok: true; weekStart: string; legacyWeekStart: string; label: string }
  | { ok: false; error: string }

/**
 * A tool's `week` argument as the Sunday key Fridgie files lists under.
 *
 * Accepts "this" (the default), "next", or any date — which means the week
 * that date falls in, in the household's zone, exactly as the app would file
 * it. A list is created for whatever week this names, so the range is bounded:
 * nobody means to plan a meal three years out, and each one would be an empty
 * week in the app's picker.
 */
export function resolveWeek(week: string | undefined, tz: string, now = new Date()): ResolvedWeek {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE
  const current = localWeekKeys(now, zone)
  const value = (week ?? 'this').trim().toLowerCase()

  if (value === 'this' || value === 'current' || value === 'this week' || value === '') {
    return { ok: true, weekStart: current.thisWeek, legacyWeekStart: current.legacyThisWeek, label: 'this week' }
  }
  if (value === 'next' || value === 'next week') {
    return { ok: true, weekStart: current.nextWeek, legacyWeekStart: current.legacyNextWeek, label: 'next week' }
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return { ok: false, error: `Unrecognised week "${week}". Use "this", "next", or a date like 2026-10-04.` }
  const [, y, m, d] = match
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) {
    return { ok: false, error: `"${week}" is not a real date.` }
  }

  // Midday on that date in the household's zone, then the week around it.
  const instant = fromZonedTime(`${value}T12:00:00`, zone)
  const keys = localWeekKeys(instant, zone)
  const offset = (dayNumber(keys.thisWeek) - dayNumber(current.thisWeek)) / 7
  if (offset < -WEEKS_BACK || offset > WEEKS_AHEAD) {
    return { ok: false, error: `Fridgie plans from ${WEEKS_BACK} weeks back to ${WEEKS_AHEAD} weeks ahead; ${week} is outside that.` }
  }
  const label = offset === 0 ? 'this week' : offset === 1 ? 'next week' : `the week of ${keys.thisWeek}`
  return { ok: true, weekStart: keys.thisWeek, legacyWeekStart: keys.legacyThisWeek, label }
}
