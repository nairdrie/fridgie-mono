import { Hono } from 'hono';
import { adminRtdb } from '@/utils/firebase';
import { auth } from '@/middleware/auth';
const route = new Hono();

route.use('*', auth); // Use your standard auth middleware

route.post('/', async (c) => {
  const { mealId, listId, sendAt } = await c.req.json();
  const uid = c.get('uid'); // Get user from auth middleware

  if (!mealId || !listId || !sendAt) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // sendAt arrives as a JSON string — parse and validate it
  const sendAtDate = new Date(sendAt);
  if (isNaN(sendAtDate.getTime())) {
    return c.json({ error: 'Invalid sendAt date' }, 400);
  }

  // 2. Get the user's push token (assuming it's stored on their user profile)
  const userSnap = await adminRtdb.ref(`users/${uid}`).once('value');
  const pushToken = userSnap.val()?.pushToken;

  if (!pushToken) {
    // Can't schedule if we don't know where to send it.
    return c.json({ status: 'ok', message: 'No push token for user.' });
  }

  // 3. Save the job under a deterministic key so scheduling is idempotent per
  // (listId, mealId): re-scheduling (e.g. when the meal's day-of-week changes)
  // replaces the previous job instead of stacking duplicates.
  const key = `${listId}_${mealId}`.replace(/[.#$\[\]\/]/g, '_');
  await adminRtdb.ref(`scheduledNotifications/${key}`).set({
    uid,
    pushToken,
    mealId,
    listId,
    sendAt: sendAtDate.toISOString(), // Store as UTC string
    sent: false,
    updatedAt: Date.now(),
  });

  return c.json({ status: 'scheduled' });
});

export default route;
