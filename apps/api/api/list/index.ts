import { Hono } from 'hono'
import { adminRtdb } from '@/utils/firebase'
import { LexoRank } from 'lexorank'
import { v4 as uuid } from 'uuid'
import { groupAuth } from '@/middleware/groupAuth'
import { auth } from '@/middleware/auth'
import {  addWeeks, startOfWeek } from 'date-fns' // isSameDay is no longer needed
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

const route = new Hono()

route.use('*', auth, groupAuth)

/**
 * Calculates a date function (like startOfWeek) relative to a specific timezone.
 * @param date The UTC date to calculate from (e.g., new Date())
 * @param tz The IANA timezone (e.g., 'America/Toronto')
 * @param fn The date-fns function to call (e.g., startOfWeek)
 * @param options The options for the date-fns function (e.g., { weekStartsOn: 0 })
 */
const calcInTimezone = (date:any, tz:any, fn:any, options:any) => {
  // 1. Get a date object representing the local time in the target zone
  const zonedDate = toZonedTime(date, tz)
  
  // 2. Run the function (e.g., startOfWeek) on that local date
  const resultDate = options ? fn(zonedDate, options) : fn(zonedDate)
  
  // 3. Convert the resulting local date back to its true UTC timestamp
  return fromZonedTime(resultDate, tz)
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

    // --- TIMEZONE FIX ---
    const now = new Date()
    const weekOptions = { weekStartsOn: 0 } // Sunday

    // Use the helper to get the start of the week *in the client's timezone*
    const thisWeekStart = calcInTimezone(now, clientTz, startOfWeek, weekOptions)
    
    // addWeeks works on the resulting UTC date, which is correct
    const nextWeekStart = addWeeks(thisWeekStart, 1)

    // These comparisons are still correct
    const thisWeekStartStr = thisWeekStart.toISOString().substring(0, 10)
    const nextWeekStartStr = nextWeekStart.toISOString().substring(0, 10)

    const hasThisWeek = allLists.some(list => list.weekStart.startsWith(thisWeekStartStr))
    const hasNextWeek = allLists.some(list => list.weekStart.startsWith(nextWeekStartStr))

    let listsWereCreated = false

    if (!hasThisWeek) {
      const id = uuid()
      data[id] = {
        weekStart: thisWeekStart.toISOString(), // Correct UTC timestamp
        items: [{
          id: uuid(),
          text: '',
          checked: false,
          order: LexoRank.middle().toString(),
        }, ],
      }
      listsWereCreated = true
    }

    if (!hasNextWeek) {
      const id = uuid()
      data[id] = {
        weekStart: nextWeekStart.toISOString(), // Correct UTC timestamp
        items: [{
          id: uuid(),
          text: '',
          checked: false,
          order: LexoRank.middle().toString(),
        }, ],
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
    const hasContent = items.length > 1 || (items.length === 1 && items[0]?.text !== '')

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

  const id = uuid()
  const newListData = {
    weekStart: new Date(weekStart).toISOString(),
    items: [{
      id: uuid(),
      text: '',
      checked: false,
      order: LexoRank.middle().toString(),
    }, ],
  }
  await adminRtdb.ref(`lists/${groupId}/${id}`).set(newListData)

  return c.json({ id, ...newListData }, 201)
})

export default route