import { Hono } from 'hono';
import { FieldPath } from 'firebase-admin/firestore';
import { auth } from '@/middleware/auth';
import { adminAuth, fs } from '@/utils/firebase';
import { isValidUserId } from '@/utils/userIds';

const route = new Hono();
route.use('*', auth);

/** GET /api/user/:id/connections?kind=followers|following&cursor=<uid>&limit=40 */
route.get('/', async (c) => {
  const ownerId = c.req.param('id');
  const kind = c.req.query('kind');
  const cursor = c.req.query('cursor');
  const rawLimit = c.req.query('limit');

  if (!isValidUserId(ownerId)) return c.json({ error: 'A valid user ID is required.' }, 400);
  if (kind !== 'followers' && kind !== 'following') {
    return c.json({ error: 'Kind must be followers or following.' }, 400);
  }
  if (cursor !== undefined && !isValidUserId(cursor)) {
    return c.json({ error: 'Cursor must be a valid user ID.' }, 400);
  }
  if (rawLimit !== undefined && (!/^-?\d+$/.test(rawLimit) || !Number.isFinite(Number(rawLimit)))) {
    return c.json({ error: 'Limit must be an integer.' }, 400);
  }
  const limit = Math.min(100, Math.max(1, rawLimit === undefined ? 40 : Number(rawLimit)));

  try {
    // A deleted profile should be a 404, not a plausible empty social graph.
    await adminAuth.getUser(ownerId);
    let query = fs.collection('users').doc(ownerId).collection(kind)
      .orderBy(FieldPath.documentId());
    if (cursor !== undefined) query = query.startAfter(cursor);
    const snapshot = await query.limit(limit + 1).get();
    const page = snapshot.docs.slice(0, limit);
    // Advance through the edges, including deleted Auth users. A page may be
    // empty after hydration and still have a cursor for the next page.
    const nextCursor = snapshot.docs.length > limit ? page[page.length - 1]!.id : null;
    if (page.length === 0) return c.json({ users: [], nextCursor });

    const records = await adminAuth.getUsers(page.map(edge => ({ uid: edge.id })));
    const recordsById = new Map(records.users.map(user => [user.uid, user]));
    const visibleIds = page.map(edge => edge.id).filter(uid => recordsById.has(uid));
    const callerFollowing = fs.collection('users').doc(c.get('uid')).collection('following');
    const followingEdges = visibleIds.length > 0
      ? await fs.getAll(...visibleIds.map(uid => callerFollowing.doc(uid)))
      : [];
    const follows = new Set(followingEdges.filter(edge => edge.exists).map(edge => edge.id));

    const users = visibleIds.map(uid => {
      const record = recordsById.get(uid)!;
      // Explicit projection: never expose Auth email, phone, or provider data.
      return {
        uid: record.uid,
        displayName: record.displayName || null,
        photoURL: record.photoURL || null,
        isFollowing: follows.has(uid),
      };
    });
    return c.json({ users, nextCursor });
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === 'auth/user-not-found') {
      return c.json({ error: 'User not found.' }, 404);
    }
    console.error('Failed to retrieve user connections:', error);
    return c.json({ error: 'Failed to retrieve user connections.' }, 500);
  }
});

export default route;
