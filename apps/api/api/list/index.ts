import { Hono } from 'hono'
import { adminRtdb } from '@/utils/firebase'
import { LexoRank } from 'lexorank'
import { v4 as uuid } from 'uuid'
import { groupAuth } from '@/middleware/groupAuth'
import { auth } from '@/middleware/auth'
import { startOfWeek, addWeeks } from 'date-fns' // isSameDay is no longer needed

const route = new Hono()

route.use('*', auth, groupAuth)

// The `createListForWeek` helper function is no longer needed
// as all list creation logic is now handled atomically inside the transaction.

// --- Final Corrected GET / Route ---
// This route ensures lists exist for this week and next week atomically and with timezone-safe checks.
route.get('/', async (c) => {
  const groupId = c.req.query('groupId')
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400)

  const listsRef = adminRtdb.ref(`lists/${groupId}`)

  // FIX 1: Use a transaction to prevent race conditions from simultaneous requests.
  const transactionResult = await listsRef.transaction((currentData) => {
    // If there's no data for this group yet, initialize it as an empty object.
    const data = currentData || {}

    const allLists = Object.entries(data).map(([id, listData]: any) => ({
      id,
      ...listData,
    }));

    // Calculate start dates. This runs on the UTC server, so dates are UTC.
    const now = new Date()
    const thisWeekStart = startOfWeek(now, { weekStartsOn: 0 }) // Sunday
    const nextWeekStart = addWeeks(thisWeekStart, 1)

    // FIX 2: Compare using YYYY-MM-DD strings to make the check timezone-proof.
    // This correctly handles a '2025-10-05T00:00Z' and '2025-10-05T04:00Z' as the same day.
    const thisWeekStartStr = thisWeekStart.toISOString().substring(0, 10)
    const nextWeekStartStr = nextWeekStart.toISOString().substring(0, 10)

    const hasThisWeek = allLists.some(list => list.weekStart.startsWith(thisWeekStartStr))
    const hasNextWeek = allLists.some(list => list.weekStart.startsWith(nextWeekStartStr))

    let listsWereCreated = false

    // Conditionally create missing lists directly inside the transaction data.
    if (!hasThisWeek) {
      const id = uuid()
      data[id] = {
        weekStart: thisWeekStart.toISOString(),
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
        weekStart: nextWeekStart.toISOString(),
        items: [{
          id: uuid(),
          text: '',
          checked: false,
          order: LexoRank.middle().toString(),
        }, ],
      }
      listsWereCreated = true
    }

    // If we didn't change anything, return undefined to abort the transaction and prevent a write.
    if (!listsWereCreated) {
      return // Abort
    }

    return data // Commit the changes
  })

  // The transaction snapshot contains the final, correct data.
  const listsData = transactionResult.snapshot.val() || {}
  const allLists = Object.entries(listsData).map(([id, data]: any) => ({ id, ...data }))

  // Format the response as before
  const formatted = allLists.map(list => {
    const items = list.items || []
    // A list has content if it's not just a single, empty placeholder item
    const hasContent = items.length > 1 || (items.length === 1 && items[0]?.text !== '')

    return {
      id: list.id,
      weekStart: list.weekStart,
      hasContent: hasContent,
    }
  })
  
  // Sort the lists chronologically before sending
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