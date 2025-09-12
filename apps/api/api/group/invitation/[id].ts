import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { adminRtdb, fs } from '@/utils/firebase';
import { getAuth } from 'firebase-admin/auth';
import { groupOwnerAuth } from '@/middleware/groupOwnerAuth';
import type { UserProfile } from '@/utils/types';

const route = new Hono();

route.use('*', auth, groupAuth, groupOwnerAuth);


// POST /api/group/invitation/:id
route.post('/', async (c) => {
  const inviterUid = c.get('uid') as string;
  const { inviteeUid } = await c.req.json<{ inviteeUid: string }>();
  const groupId = c.req.param('id');

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

route.get('/', async (c) => {
  console.log("HIT GET PENDING INVITATIONS")
    const groupId = c.req.param('id');

    try {
        const invitationsSnapshot = await fs.collection('group_invitations')
            .where('groupId', '==', groupId)
            .where('status', '==', 'pending')
            .get();

        if (invitationsSnapshot.empty) {
            return c.json([]);
        }

        const invitationsPromises = invitationsSnapshot.docs.map(async (doc) => {
            const invitationData = doc.data();
            const userRecord = await getAuth().getUser(invitationData.inviteeUid);
            
            const invitee: UserProfile = {
                uid: userRecord.uid,
                displayName: userRecord.displayName || null,
                photoURL: userRecord.photoURL || null,
                email: userRecord.email || null,
                phoneNumber: userRecord.phoneNumber || null,
            };

            return {
                id: doc.id,
                groupId: invitationData.groupId,
                groupName: invitationData.groupName,
                inviterName: invitationData.inviterName,
                invitee,
            };
        });

        const invitations = await Promise.all(invitationsPromises);

        return c.json(invitations);
    } catch (error) {
        console.error(`Failed to fetch invitations for group ${groupId}:`, error);
        return c.json({ error: 'Failed to fetch invitations' }, 500);
    }
});

export default route;
