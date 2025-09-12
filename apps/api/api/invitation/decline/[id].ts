import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';
import type { GroupInvitation } from '@/utils/types';

const route = new Hono();

route.use('*', auth);

// /api/invitation/decline/:id
route.post('/', async (c) => {
  const uid = c.get('uid') as string;
  const invitationId = c.req.param('id');

  if(!invitationId) {
    return c.json({ error: 'Missing invitationId' }, 400);
  }
  try {
    const invitationRef = fs.collection('group_invitations').doc(invitationId);
    const invitationDoc = await invitationRef.get();

    if (!invitationDoc.exists) {
      return c.json({ error: 'Invitation not found' }, 404);
    }

    const invitation = invitationDoc.data() as GroupInvitation;

    if (invitation.inviteeUid !== uid) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Delete invitation
    await invitationRef.delete();

    // Mark notification as read (or delete it)
    const notificationsQuery = fs.collection('notifications')
      .where('data.invitationId', '==', invitationId);

    const notificationsSnapshot = await notificationsQuery.get();

    const batch = fs.batch();
    notificationsSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    return c.json({ success: true });
  } catch (error) {
    console.error('Error declining invitation:', error);
    return c.json({ error: 'Failed to decline invitation' }, 500);
  }
});

export default route;
