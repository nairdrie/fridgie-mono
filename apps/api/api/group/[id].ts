import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { adminRtdb } from '@/utils/firebase';
import { groupOwnerAuth } from '@/middleware/groupOwnerAuth';

const route = new Hono();

route.use('*', auth, groupAuth, groupOwnerAuth);

route.put('/', async (c) => {
  const groupId = c.req.param('id');
  // Expect name and/or members in the request body
  const { name, members } = await c.req.json<{ name?: string; members?: string[] }>();

  // Ensure at least one field is being updated
  if (!name && !members) {
    return c.json({ error: 'Name or members is required for an update' }, 400);
  }

  const updates: { [key: string]: any } = {};

  if (name) {
    updates.name = name;
  }

  if (members) {
    // CORRECT: Transform the array of member UIDs into the required Firebase structure:
    // from: ["uid1", "uid2"]
    // to:   { "uid1": true, "uid2": true }
    const membersMap = members.reduce((acc, uid) => {
      acc[uid] = true;
      return acc;
    }, {} as Record<string, boolean>);
    updates.members = membersMap;
  }

  try {
    await adminRtdb.ref(`groups/${groupId}`).update(updates);
    return c.json({ success: true });
  } catch (error) {
    console.error(`Failed to update group ${groupId}:`, error);
    return c.json({ error: 'Failed to update group' }, 500);
  }
});

// DELETE /api/group/[id]
route.delete('/', async (c) => {
  const groupId = c.req.param('id');

  try {
    // The checks for group existence (groupAuth) and ownership (groupOwnerAuth)
    // are now complete. We can proceed directly with the deletion.
    await adminRtdb.ref(`groups/${groupId}`).remove();
    return c.json({ success: true, message: `Group ${groupId} deleted.` });
  } catch (error) {
    console.error(`Failed to delete group ${groupId}:`, error);
    return c.json({ error: 'Failed to delete group' }, 500);
  }
});

export default route;
