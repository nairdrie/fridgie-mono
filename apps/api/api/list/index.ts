import { Hono } from 'hono'
import { adminRtdb } from '@/utils/firebase'
import { LexoRank } from 'lexorank'
import { v4 as uuid } from 'uuid'
import { groupAuth } from '@/middleware/groupAuth'
import { auth } from '@/middleware/auth'
import { addWeeks, format, startOfWeek } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const route = new Hono()

route.use('*', auth, groupAuth)

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
const localWeekKeys = (now: Date, tz: string) => {
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

const matchesWeek = (stored: unknown, ...keys: string[]) => {
  const value = typeof stored === 'string' ? stored : ''
  return keys.some((k) => value.startsWith(k))
}

// The `createListForWeek` helper function is no longer needed
// as all list creation logic is now handled atomically inside the transaction.

// --- Final Corrected GET / Route ---
// This route ensures lists exist for this week and next week atomically and with timezone-safe checks.
route.get('/', async (c) => {
  const groupId = c.req.query('groupId')
  const clientTz = c.req.query('tz') // e.g., 'America/Toronto'

  if (!groupId) return c.json({ error: 'Missing groupId' }, 400)
  if (!clientTz) return c.json({ error: 'Missing tz (timezone) query param' }, 400)

  const listsRef = adminRtdb.ref(`lists/${groupId}`)

  const transactionResult = await listsRef.transaction((currentData) => {
    const data = currentData || {}

    const allLists = Object.entries(data).map(([id, listData]: any) => ({
      id,
      ...listData,
    }));

    const keys = localWeekKeys(new Date(), clientTz)

    const hasThisWeek = allLists.some(list =>
      matchesWeek(list.weekStart, keys.thisWeek, keys.legacyThisWeek))
    const hasNextWeek = allLists.some(list =>
      matchesWeek(list.weekStart, keys.nextWeek, keys.legacyNextWeek))

    let listsWereCreated = false

    if (!hasThisWeek) {
      const id = uuid()
      data[id] = {
        weekStart: keys.thisWeek, // bare local yyyy-MM-dd Sunday
        items: [{
          id: uuid(),
          text: '',
          checked: false,
          isSection: false,
          listOrder: LexoRank.middle().toString(),
        }, ],
        rev: 1,
      }
      listsWereCreated = true
    }

    if (!hasNextWeek) {
      const id = uuid()
      data[id] = {
        weekStart: keys.nextWeek, // bare local yyyy-MM-dd Sunday
        items: [{
          id: uuid(),
          text: '',
          checked: false,
          isSection: false,
          listOrder: LexoRank.middle().toString(),
        }, ],
        rev: 1,
      }
      listsWereCreated = true
    }

    if (!listsWereCreated) {
      return // Abort
    }

    return data // Commit
  })

  // (The rest of your response formatting code is perfect and needs no changes)
  // ...
  const listsData = transactionResult.snapshot.val() || {}
  const allLists = Object.entries(listsData).map(([id, data]: any) => ({ id, ...data }))

  const formatted = allLists.map(list => {
    const items = list.items || []
    // Meals count as content too. Deriving this from grocery items alone meant a
    // week with a meal plan but no groceries looked empty, so the app skipped
    // past it on launch and the user's planning appeared lost.
    const hasMeals = Array.isArray(list.meals) ? list.meals.length > 0 : !!list.meals
    const hasContent = items.length > 1 || (items.length === 1 && items[0]?.text !== '') || hasMeals

    return {
      id: list.id,
      weekStart: list.weekStart,
      hasContent: hasContent,
    }
  })
  
  formatted.sort((a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime())

  return c.json(formatted)
})


// --- POST / Route (No changes needed) ---
// This route is correct as-is. It stores the timestamp provided by the client.
// The GET route is now resilient to the different timestamp formats this may create.
route.post('/', async (c) => {
  const groupId = c.req.query('groupId')
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400)

  const { weekStart } = await c.req.json()
  if (!weekStart) return c.json({ error: 'Missing weekStart in body' }, 400)

  // Store the bare local date key the client sent. Re-deriving it via
  // `new Date(weekStart).toISOString()` would reinterpret a bare `yyyy-MM-dd`
  // as UTC midnight and shift it a day for anyone west of Greenwich.
  const weekStartKey = String(weekStart).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartKey)) {
    return c.json({ error: 'weekStart must be a yyyy-MM-dd date key' }, 400)
  }

  const id = uuid()
  const newListData = {
    weekStart: weekStartKey,
    items: [{
      id: uuid(),
      text: '',
      checked: false,
      isSection: false,
      listOrder: LexoRank.middle().toString(),
    }, ],
    rev: 1,
  }
  await adminRtdb.ref(`lists/${groupId}/${id}`).set(newListData)

  return c.json({ id, ...newListData }, 201)
})

export default route