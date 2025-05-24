// api/group/index.ts
import { Hono } from 'hono'
import { adminRtdb } from '../../utils/firebase'
import { v4 as uuid } from 'uuid'
import { auth } from '../../middleware/auth'

const route = new Hono()

// 1) Protect every /api/group/* route
route.use('*', auth)

// GET /api/groups
route.get('/', async (c) => {
  const uid = c.get('uid') as string
  const snap = await adminRtdb.ref('groups').once('value')
  const all = snap.val() || {}

  // only return groups this user is a member of
  let formatted = Object.entries(all)
    .filter(([, data]: any) => data.members?.[uid])
    .map(([id, data]: any) => ({
      id,
      name: data.name,
      owner: data.owner,
    }))

  // ensure the user owns at least one group; if not, create "My Lists"
  if (!formatted.some(g => g.owner === uid)) {
    const myListsId = uuid()
    const newGroup = {
      name: 'My Lists',
      owner: uid,
      members: { [uid]: true },
      createdAt: Date.now(),
    }
    await adminRtdb.ref(`groups/${myListsId}`).set(newGroup)
    formatted.unshift({ id: myListsId, name: 'My Lists', owner: uid })
  }

  return c.json(formatted)
})

// POST /api/groups
route.post('/', async (c) => {
  const uid = c.get('uid') as string
  const { name } = await c.req.json<{ name?: string }>()

  if (!name || typeof name !== 'string') {
    return c.json({ error: '`name` is required' }, 400)
  }

  const id = uuid()
  const newGroup = {
    name,
    owner: uid,
    members: { [uid]: true },
    createdAt: Date.now(),
  }

  // 5) write under this user’s node
  await adminRtdb.ref(`groups/${id}`).set(newGroup)

  return c.json({ id, ...newGroup })
})

export default route
