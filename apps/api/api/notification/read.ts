import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';

const route = new Hono();

route.use('*', auth);

// Firestore caps a write batch at 500 operations.
const BATCH_LIMIT = 500;

/**
 * POST /api/notification/read
 *
 * Marks every unread notification for the caller as read. `GET /notification`
 * only ever returns `read == false` docs, so this is what empties the bell
 * badge — the docs stay in Firestore for a future full notification history.
 *
 * Idempotent: a second call finds nothing unread and writes nothing.
 */
route.post('/', async (c) => {
  const uid = c.get('uid') as string;

  try {
    // Equality-only, so the existing (recipientUid, read, createdAt) index
    // serves it; no orderBy because the update order does not matter.
    const unread = await fs
      .collection('notifications')
      .where('recipientUid', '==', uid)
      .where('read', '==', false)
      .get();

    if (unread.empty) {
      return c.json({ updated: 0 });
    }

    // One batch per 500 docs. A user with more unread notifications than that
    // is unlikely, but a silently truncated write would leave a badge that
    // never clears.
    for (let i = 0; i < unread.docs.length; i += BATCH_LIMIT) {
      const batch = fs.batch();
      for (const doc of unread.docs.slice(i, i + BATCH_LIMIT)) {
        batch.update(doc.ref, { read: true });
      }
      await batch.commit();
    }

    return c.json({ updated: unread.size });
  } catch (error) {
    console.error('Error marking notifications read:', error);
    return c.json({ error: 'Failed to mark notifications read' }, 500);
  }
});

export default route;
