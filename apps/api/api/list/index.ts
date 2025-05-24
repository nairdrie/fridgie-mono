// api/list/index.ts
import { Hono } from 'hono'
import { adminRtdb } from '../../utils/firebase'
import { LexoRank } from 'lexorank'
import { v4 as uuid } from 'uuid'
import { groupAuth } from '../../middleware/groupAuth'
import { auth } from '../../middleware/auth'

const route = new Hono()

route.use('*', auth, groupAuth)

route.get('/', async (c) => {
  const groupId = c.req.query('groupId')
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400)

  const snap = await adminRtdb
    .ref(`lists/${groupId}`)    // ← now under both uid & groupId
    .once('value')

  const lists = snap.val() || {}
  const formatted = Object.entries(lists).map(([id, data]: any) => ({
    id,
    weekStart: data.weekStart,
  }))

  return c.json(formatted)
})

route.post('/', async (c) => {
  const uid     = c.get('uid') as string
  const groupId = c.req.query('groupId')
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400)

  const { weekStart } = await c.req.json()
  const id = uuid()
  const newList = {
    weekStart,
    items: [{
      id: uuid(),
      text: '',
      checked: false,
      order: LexoRank.middle().toString(),
    }],
  }

  await adminRtdb
    .ref(`lists/${groupId}/${id}`)  // ← write under that path
    .set(newList)

  return c.json({ id, ...newList })
})

export default route
