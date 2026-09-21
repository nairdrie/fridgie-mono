import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';
import { isValidUserId } from '@/utils/userIds';

const route = new Hono();
route.use('*', auth);

const decrementedCount = (value: unknown) =>
  Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value - 1 : 0);

/** DELETE /api/user/follower/:id — remove a follower from the caller only. */
route.delete('/', async (c) => {
  const ownerId = c.get('uid');
  const followerId = c.req.param('id');
  if (!isValidUserId(followerId)) return c.json({ error: 'A valid follower ID is required.' }, 400);
  if (followerId === ownerId) return c.json({ error: 'You cannot remove yourself as a follower.' }, 400);

  try {
    const ownerRef = fs.collection('users').doc(ownerId);
    const otherUserRef = fs.collection('users').doc(followerId);
    const followerRef = ownerRef.collection('followers').doc(followerId);
    const followingRef = otherUserRef.collection('following').doc(ownerId);

    await fs.runTransaction(async transaction => {
      // All reads precede writes. Profile snapshots make the clamped counter
      // updates safe under concurrent follow/unfollow requests, too.
      const [followerEdge, followingEdge, owner, otherUser] = await transaction.getAll(
        followerRef, followingRef, ownerRef, otherUserRef,
      );
      transaction.delete(followerRef);
      transaction.delete(followingRef);
      // Each counter represents its own collection. A legacy one-sided edge
      // only decrements the side that exists; retrying removes neither twice.
      if (followerEdge!.exists && owner!.exists) {
        transaction.set(ownerRef, { followerCount: decrementedCount(owner!.data()?.followerCount) }, { merge: true });
      }
      if (followingEdge!.exists && otherUser!.exists) {
        transaction.set(otherUserRef, { followingCount: decrementedCount(otherUser!.data()?.followingCount) }, { merge: true });
      }
    });
    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to remove follower:', error);
    return c.json({ error: 'Failed to remove follower.' }, 500);
  }
});

export default route;
