import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';

const route = new Hono();

route.use('*', auth);

route.get('/', async (c) => {
  const uid = c.get('uid') as string;

  try {
    const notificationsSnapshot = await fs
      .collection('notifications')
      .where('recipientUid', '==', uid)
      .where('read', '==', false)
      .orderBy('createdAt', 'desc')
      .get();

    const notifications = notificationsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return c.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return c.json({ error: 'Failed to fetch notifications' }, 500);
  }
});

export default route;
