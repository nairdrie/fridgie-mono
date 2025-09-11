import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { adminRtdb, fs } from '@/utils/firebase';
import { getAuth } from 'firebase-admin/auth';

const route = new Hono();

route.use('*', auth, groupAuth);

route.post('/', async (c) => {
  const inviterUid = c.get('uid') as string;
  const { inviteeUid } = await c.req.json<{ inviteeUid: string }>();
  const groupId = c.req.param('groupId');

  if (!inviteeUid) {
    return c.json({ error: 'inviteeUid is required' }, 400);
  }

  try {
    // Fetch inviter's name from Firebase Auth
    const inviterRecord = await getAuth().getUser(inviterUid);
    const inviterName = inviterRecord.displayName || inviterRecord.email || 'A user';

    // Fetch group name from Realtime Database
    const groupSnapshot = await adminRtdb.ref(`groups/${groupId}`).once('value');
    const group = groupSnapshot.val();
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    const groupName = group.name;

    // Create invitation
    const invitationRef = fs.collection('group_invitations').doc();
    const invitation = {
      groupId,
      groupName,
      inviterUid,
      inviterName,
      inviteeUid,
      status: 'pending',
      createdAt: new Date(),
    };
    await invitationRef.set(invitation);

    // Create notification
    const notificationRef = fs.collection('notifications').doc();
    await notificationRef.set({
      recipientUid: inviteeUid,
      type: 'group_invitation',
      read: false,
      createdAt: new Date(),
      data: {
        invitationId: invitationRef.id,
        groupId,
        groupName,
        inviterName,
      },
    });

    return c.json({ success: true, invitationId: invitationRef.id });
  } catch (error) {
    console.error('Error creating invitation:', error);
    return c.json({ error: 'Failed to create invitation' }, 500);
  }
});

export default route;
