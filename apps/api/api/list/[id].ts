// api/list/[id].ts
import { Hono } from 'hono'
import { adminRtdb } from '../../utils/firebase'
import { groupAuth } from '../../middleware/groupAuth'
import { auth } from '../../middleware/auth'

const route = new Hono()

route.use('*', auth, groupAuth)

route.get('/', async (c) => {
  const id = c.req.param('id')
  const groupId = c.req.query('groupId')

  if (!id) return c.json({ error: 'Missing id' }, 400)
  const snap = await adminRtdb.ref(`lists/${groupId}/${id}`).once('value')
  const data = snap.val()
  if (!data) return c.json({ error: 'Not found' }, 404)
  return c.json(data)
})

route.post('/', async (c) => {
  const id = c.req.param('id')
  const groupId = c.req.query('groupId')
  if (!id) return c.json({ error: 'Missing id' }, 400)
  const body = await c.req.json()
  await adminRtdb.ref(`lists/${groupId}/${id}`).update(body)
  return c.json({ status: 'updated' })
})

export default route
