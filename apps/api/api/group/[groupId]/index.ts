import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { adminRtdb } from '@/utils/firebase';

const route = new Hono();

route.use('*', auth, groupAuth);

// PUT /api/group/[groupId]
route.put('/', async (c) => {
  const groupId = c.req.param('groupId');
  const { name } = await c.req.json<{ name: string }>();

  if (!name) {
    return c.json({ error: 'Name is required' }, 400);
  }

  try {
    await adminRtdb.ref(`groups/${groupId}`).update({ name });
    return c.json({ success: true });
  } catch (error) {
    console.error(`Failed to update group ${groupId}:`, error);
    return c.json({ error: 'Failed to update group' }, 500);
  }
});

// DELETE /api/group/[groupId]
route.delete('/', async (c) => {
  const groupId = c.req.param('groupId');
  const uid = c.get('uid') as string;

  try {
    const groupRef = adminRtdb.ref(`groups/${groupId}`);
    const groupSnapshot = await groupRef.once('value');
    const group = groupSnapshot.val();

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (group.owner !== uid) {
      return c.json({ error: 'Only the group owner can delete the group' }, 403);
    }

    await groupRef.remove();
    return c.json({ success: true });
  } catch (error) {
    console.error(`Failed to delete group ${groupId}:`, error);
    return c.json({ error: 'Failed to delete group' }, 500);
  }
});

export default route;
