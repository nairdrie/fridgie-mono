// api/staples/index.ts
//
// What this household has been observed to always have in. Written from
// api/list/[id].ts as a side effect of saving a list; read here so the grocery
// list can file those rows away instead of showing them.
//
// Read-only. There is deliberately no way to ADD a staple by hand: the whole
// premise is that nobody maintains a pantry inventory, and an "add staple"
// button is the first step of building one. Corrections go the other way —
// see [key].ts.

import { Hono } from 'hono'
import { auth } from '@/middleware/auth'
import { groupAuth } from '@/middleware/groupAuth'
import { getStapleRecords } from '@/utils/stapleStore'

const route = new Hono()

route.use('*', auth, groupAuth)

route.get('/', async (c) => {
  const groupId = c.req.query('groupId')
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400)

  try {
    const { staples } = await getStapleRecords(groupId)
    return c.json({ staples })
  } catch (error) {
    // A household with no staples and a household we failed to read look the
    // same to the client, and both render the list exactly as it does today.
    // That is the right way for this to fail: showing an item you already own
    // costs a moment, hiding one you needed costs the meal.
    console.error(`Failed to read staples for group ${groupId}:`, error)
    return c.json({ staples: [] })
  }
})

export default route
