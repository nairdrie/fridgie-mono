import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { adminRtdb } from '@/utils/firebase';
import { groupOwnerAuth } from '@/middleware/groupOwnerAuth';

const route = new Hono();

route.use('*', auth, groupAuth, groupOwnerAuth);

/**
 * PUT /api/group/:id
 * Body: { name?, addMembers?: string[], removeMembers?: string[] }
 *
 * Membership is applied as a DELTA via per-uid paths. It used to accept an
 * absolute `members` array and replace the whole map, so anyone who accepted an
 * invitation while the owner had the editor open was silently ejected — the
 * owner only had to rename the group to wipe them out.
 */
route.put('/', async (c) => {
  const groupId = c.req.param('id');
  const { name, addMembers, removeMembers } = await c.req.json<{
    name?: string;
    addMembers?: string[];
    removeMembers?: string[];
  }>();

  const toAdd = Array.isArray(addMembers) ? addMembers : [];
  const toRemove = Array.isArray(removeMembers) ? removeMembers : [];

  if (!name && toAdd.length === 0 && toRemove.length === 0) {
    return c.json({ error: 'Name, addMembers or removeMembers is required for an update' }, 400);
  }

  const groupRef = adminRtdb.ref(`groups/${groupId}`);

  try {
    const ownerSnap = await groupRef.child('owner').once('value');
    const owner = ownerSnap.val();
    if (toRemove.includes(owner)) {
      return c.json({ error: 'Cannot remove the group owner' }, 400);
    }

    const updates: { [key: string]: any } = {};
    if (name) updates.name = name;
    for (const uid of toAdd) updates[`members/${uid}`] = true;
    // null deletes just this child, leaving every other member untouched.
    for (const uid of toRemove) updates[`members/${uid}`] = null;

    await groupRef.update(updates);
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
