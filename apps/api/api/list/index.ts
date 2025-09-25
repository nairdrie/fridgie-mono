import { Hono } from 'hono'
import { adminRtdb } from '@/utils/firebase'
import { LexoRank } from 'lexorank'
import { v4 as uuid } from 'uuid'
import { groupAuth } from '@/middleware/groupAuth'
import { auth } from '@/middleware/auth'
import { startOfWeek, addWeeks, isSameDay } from 'date-fns'

const route = new Hono()

route.use('*', auth, groupAuth)

// TODO: we are somehow still making duplicate lists. or wrong day of week start causing dupe. 

// --- Reusable Helper Function for Creating Lists ---
// This function creates a new list with a blank item but only returns its metadata.
async function createListForWeek(groupId: string, weekStartDate: Date) {
  const id = uuid()
  const newListData = {
    weekStart: weekStartDate.toISOString(),
    items: [
      {
        id: uuid(),
        text: '',
        checked: false,
        order: LexoRank.middle().toString(),
      },
    ],
  }

  await adminRtdb.ref(`lists/${groupId}/${id}`).set(newListData)
  
  // ✅ Return only the id and weekStart, not the full items array.
  return { id, weekStart: newListData.weekStart }
}


// --- Updated GET / Route ---
// This route ensures lists exist but only returns their metadata.
route.get('/', async (c) => {
  const groupId = c.req.query('groupId')
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400)

  // 1. Fetch all existing lists for the group
  const snap = await adminRtdb.ref(`lists/${groupId}`).once('value')
  const listsData = snap.val() || {}
  
  // We only need the weekStart from existing data for our checks.
  let allLists = Object.entries(listsData).map(([id, data]: any) => ({ id, ...data, }));

  // 2. Calculate the start dates for this week and next week
  const now = new Date()
  const thisWeekStart = startOfWeek(now, { weekStartsOn: 0 }) // Sunday
  const nextWeekStart = addWeeks(thisWeekStart, 1)

  // 3. Check if lists for these weeks already exist
  const hasThisWeek = allLists.some(list => isSameDay(new Date(list.weekStart), thisWeekStart))
  const hasNextWeek = allLists.some(list => isSameDay(new Date(list.weekStart), nextWeekStart))

  // 4. Conditionally create any missing lists
  if (!hasThisWeek) {
    const newListMetadata = await createListForWeek(groupId, thisWeekStart)
    allLists.push(newListMetadata)
  }
  if (!hasNextWeek) {
    const newListMetadata = await createListForWeek(groupId, nextWeekStart)
    allLists.push(newListMetadata)
  }

  const formatted = allLists.map(list => {
    const items = list.items || [];
    // A list has content if it's not just a single, empty placeholder item
    const hasContent = items.length > 1 || (items.length === 1 && items[0]?.text !== '');
    
    return {
      id: list.id,
      weekStart: list.weekStart,
      hasContent: hasContent, // Add this property
    };
  });
  // Sort the lists chronologically before sending
  formatted.sort((a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime());

  return c.json(formatted)
})


// --- Updated POST / Route ---
// This route now uses the helper function and returns the full new list object.
route.post('/', async (c) => {
  const groupId = c.req.query('groupId')
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400)

  const { weekStart } = await c.req.json()
  if (!weekStart) return c.json({ error: 'Missing weekStart in body' }, 400)

  const id = uuid()
  const newListData = {
    weekStart: new Date(weekStart).toISOString(),
    items: [
      {
        id: uuid(),
        text: '',
        checked: false,
        order: LexoRank.middle().toString(),
      },
    ],
  }
  await adminRtdb.ref(`lists/${groupId}/${id}`).set(newListData)

  return c.json({ id, ...newListData }, 201)
})

export default route