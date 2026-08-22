import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { adminRtdb } from '@/utils/firebase';
import { groupOwnerAuth } from '@/middleware/groupOwnerAuth';

const route = new Hono();

route.use('*', auth, groupAuth, groupOwnerAuth);

/**
 * The largest household this will scale a recipe to. Past this the number is a
 * typo or someone testing the input, and the cost of believing it is a
 * shopping list asking for six kilos of mince.
 */
const MAX_HOUSEHOLD_SIZE = 20;

/**
 * PUT /api/group/:id
 * Body: { name?, addMembers?: string[], removeMembers?: string[], householdSize? }
 *
 * Membership is applied as a DELTA via per-uid paths. It used to accept an
 * absolute `members` array and replace the whole map, so anyone who accepted an
 * invitation while the owner had the editor open was silently ejected — the
 * owner only had to rename the group to wipe them out.
 *
 * `householdSize` is owner-gated like everything else on this route. That is a
 * deliberate v1 simplification rather than a claim about who ought to own the
 * setting: the overwhelmingly common group is the one-member 'Private' group,
 * where the owner is the only person there.
 */
route.put('/', async (c) => {
  const groupId = c.req.param('id');
  const { name, addMembers, removeMembers, householdSize } = await c.req.json<{
    name?: string;
    addMembers?: string[];
    removeMembers?: string[];
    householdSize?: number | null;
  }>();

  const toAdd = Array.isArray(addMembers) ? addMembers : [];
  const toRemove = Array.isArray(removeMembers) ? removeMembers : [];

  // null is meaningful and distinct from absent: it CLEARS the setting, which
  // is the only way back to "don't scale" once a size has been set.
  const householdSizeGiven = householdSize !== undefined;
  if (householdSizeGiven && householdSize !== null) {
    if (
      typeof householdSize !== 'number' ||
      !Number.isInteger(householdSize) ||
      householdSize < 1 ||
      householdSize > MAX_HOUSEHOLD_SIZE
    ) {
      return c.json({ error: `householdSize must be a whole number from 1 to ${MAX_HOUSEHOLD_SIZE}` }, 400);
    }
  }

  if (!name && toAdd.length === 0 && toRemove.length === 0 && !householdSizeGiven) {
    return c.json({ error: 'Name, addMembers, removeMembers or householdSize is required for an update' }, 400);
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
    // null removes the key in RTDB, which is exactly what clearing means here.
    if (householdSizeGiven) updates.householdSize = householdSize;
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
