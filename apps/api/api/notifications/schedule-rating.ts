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

  // 2. Get the user's push token (assuming it's stored on their user profile)
  const userSnap = await adminRtdb.ref(`users/${uid}`).once('value');
  const pushToken = userSnap.val()?.pushToken;

  if (!pushToken) {
    // Can't schedule if we don't know where to send it.
    // You could just log this or return a specific status.
    return c.json({ status: 'ok', message: 'No push token for user.' });
  }

  // 3. Save the job to a new location in your database
  const notificationRef = adminRtdb.ref(`scheduledNotifications`).push();
  await notificationRef.set({
    uid,
    pushToken,
    mealId,
    listId,
    sendAt: sendAt.toISOString(), // Store as UTC string
    sent: false,
  });

  return c.json({ status: 'scheduled' });
});

export default route;