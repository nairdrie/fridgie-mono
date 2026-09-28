import { LexoRank } from 'lexorank'
import { v4 as uuid } from 'uuid'
import { addWeeks, format, startOfWeek } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { adminRtdb } from './firebase'

/**
 * The Sunday starting the caller's local week, as a bare `yyyy-MM-dd` key.
 *
 * weekStart used to be persisted as a UTC *instant* (`fromZonedTime(...)
 * .toISOString()`). For every zone east of Greenwich that instant falls on the
 * previous UTC day, so the client — which reads `weekStart.slice(0, 10)` as a
 * local date — saw Saturday and shifted the entire app back one week. Keeping
 * the value in local calendar fields and never round-tripping through UTC also
 * makes the arithmetic immune to DST transitions across UTC+0.
 */
export const localWeekKeys = (now: Date, tz: string) => {
  const zonedNow = toZonedTime(now, tz)
  const thisWeekLocal = startOfWeek(zonedNow, { weekStartsOn: 0 })
  const nextWeekLocal = addWeeks(thisWeekLocal, 1)
  return {
    thisWeek: format(thisWeekLocal, 'yyyy-MM-dd'),
    nextWeek: format(nextWeekLocal, 'yyyy-MM-dd'),
    // What the old code would have written for the same week, so pre-existing
    // lists are still recognised and we don't create duplicates on rollout.
    legacyThisWeek: fromZonedTime(thisWeekLocal, tz).toISOString().substring(0, 10),
    legacyNextWeek: fromZonedTime(nextWeekLocal, tz).toISOString().substring(0, 10),
  }
}

export const matchesWeek = (stored: unknown, ...keys: string[]) => {
  const value = typeof stored === 'string' ? stored : ''
  return keys.some((k) => value.startsWith(k))
}

/** A freshly created list: one blank row for the user to type into. */
export const blankListDoc = (weekStart: string) => ({
  weekStart,
  items: [{
    id: uuid(),
    text: '',
    checked: false,
    isSection: false,
    listOrder: LexoRank.middle().toString(),
  }],
  rev: 1,
})

/**
 * The id of the group's list for the week starting `weekKey`, creating it if
 * the household doesn't have one yet.
 *
 * Runs as a transaction over the whole group, like GET /api/list, so a second
 * device opening the app at the same moment can't create a duplicate week.
 * `legacyKey` is the pre-fix UTC spelling of the same week (see
 * `localWeekKeys`), so an old list is found rather than shadowed.
 */
export async function findOrCreateWeekList(
  groupId: string,
  weekKey: string,
  legacyKey?: string,
): Promise<{ listId: string; created: boolean }> {
  const keys = legacyKey ? [weekKey, legacyKey] : [weekKey]
  let createdId: string | null = null

  const result = await adminRtdb.ref(`lists/${groupId}`).transaction((current) => {
    const data = current || {}
    const found = Object.values<any>(data).some((list) => matchesWeek(list?.weekStart, ...keys))
    if (found) {
      createdId = null
      return // abort — nothing to write
    }
    createdId = uuid()
    data[createdId] = blankListDoc(weekKey)
    return data
  })

  const lists = (result.snapshot.val() || {}) as Record<string, any>
  const match = Object.entries(lists).find(([, list]) => matchesWeek(list?.weekStart, ...keys))
  if (!match) throw new Error(`No list for week ${weekKey} in group ${groupId}`)
  return { listId: match[0], created: result.committed && match[0] === createdId }
}
