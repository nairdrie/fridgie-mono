import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';

const route = new Hono();

route.use('*', auth);

route.delete('/', async (c) => {
  const uid = c.get('uid') as string;
  const id = c.req.param('id');

  if (!id) {
    return c.json({ error: 'Notification ID is required' }, 400);
  }

  try {
    const notificationRef = fs.collection('notifications').doc(id);
    const doc = await notificationRef.get();

    if (!doc.exists) {
      return c.json({ error: 'Notification not found' }, 404);
    }

    const notificationData = doc.data();
    if (notificationData?.recipientUid !== uid) {
      // Prevent users from deleting notifications that aren't theirs
      return c.json({ error: 'Forbidden' }, 403);
    }

    await notificationRef.delete();

    return c.json({ message: 'Notification dismissed successfully' });
  } catch (error) {
    console.error('Error dismissing notification:', error);
    return c.json({ error: 'Failed to dismiss notification' }, 500);
  }
});

export default route;
