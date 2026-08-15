// api/group/index.ts
import { Hono } from 'hono'
import { adminRtdb, fs } from '@/utils/firebase'
import { v4 as uuid } from 'uuid'
import { auth } from '@/middleware/auth'
import { getAuth } from 'firebase-admin/auth';
interface UserProfile {
  uid: string;
  email?: string | null;
  phoneNumber?: string | null;
  photoURL: string | null;
  displayName: string | null;
  // Add other properties from your user document here
}

const route = new Hono()

// 1) Protect every /api/group/* route
route.use('*', auth)

// GET /api/group
route.get('/', async (c) => {
  const uid = c.get('uid') as string
  const snap = await adminRtdb.ref('groups').once('value')
  const all = snap.val() || {}

  // only return groups this user is a member of
  let userGroups = Object.entries(all)
    .filter(([, data]: any) => data.members?.[uid])
    .map(([id, data]: any) => ({
      id,
      name: data.name,
      owner: data.owner,
      members: data.members
    }))


  // ensure the user owns at least one group; if not, create "Private"
  if (!userGroups.some(g => g.owner === uid)) {
    const myListsId = uuid()
    const newGroup = {
      name: 'Private',
      owner: uid,
      members: { [uid]: true },
      createdAt: Date.now(),
    }
    await adminRtdb.ref(`groups/${myListsId}`).set(newGroup)
    userGroups.unshift({ id: myListsId, name: 'Private', owner: uid , members: { [uid]: true }})
  }

  const allMemberUids = new Set<string>();
  userGroups.forEach(group => {
    Object.keys(group.members).forEach(memberUid => allMemberUids.add(memberUid));
  });

  if (allMemberUids.size === 0) {
    return c.json(userGroups.map(g => ({ ...g, members: [] })))
  }

  // ✅ 3. Fetch all user records from Firebase Auth in one efficient call
  const uidsToFetch = Array.from(allMemberUids).map(uid => ({ uid }));
  const userRecordsResult = await getAuth().getUsers(uidsToFetch);
  
  // ✅ 4. Create a simple map of UID -> Profile for easy lookup
  const profilesMap: { [key: string]: UserProfile } = {};
  userRecordsResult.users.forEach(user => {
    profilesMap[user.uid] = {
      uid: user.uid,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
    };
  });

  // ✅ 5. Replace the member UIDs object with an array of full profiles
  const groupsWithProfiles = userGroups.map(group => {
    const memberProfiles = Object.keys(group.members)
      .map(uid => profilesMap[uid])
      .filter(Boolean); // Filter out any profiles that might not have been found

    return {
      ...group,
      members: memberProfiles, // Replace the object with the new array
    };
  });
  
  return c.json(groupsWithProfiles);
})

// POST /api/group
route.post('/', async (c) => {
    const uid = c.get('uid') as string;
    const { name, inviteeUids } = await c.req.json<{ name?: string, inviteeUids?: string[] }>();

    if (!name || typeof name !== 'string') {
        return c.json({ error: '`name` is required' }, 400);
    }

    const id = uuid();
    const newGroupForDb = {
        name,
        owner: uid,
        members: { [uid]: true },
        createdAt: Date.now(),
    };

    try {
        // Step 1: Create the group in the Realtime Database.
        console.log(`Attempting to create group '${name}' in RTDB with id: ${id}`);
        await adminRtdb.ref(`groups/${id}`).set(newGroupForDb);
        console.log(`Successfully created group in RTDB.`);

        // Step 2: If there are invitees, send invitations.
        if (inviteeUids && inviteeUids.length > 0) {
            console.log(`Attempting to send ${inviteeUids.length} invitations...`);
            const inviterRecord = await getAuth().getUser(uid);
            const inviterName = inviterRecord.displayName || inviterRecord.email || 'A user';

            const invitationPromises = inviteeUids.map(inviteeUid => {
                const invitationRef = fs.collection('group_invitations').doc();
                const notificationRef = fs.collection('notifications').doc();
                const batch = fs.batch();

                // Batch the two Firestore writes (invitation + notification)
                batch.set(invitationRef, { groupId: id, groupName: name, inviterUid: uid, inviterName, inviteeUid, status: 'pending', createdAt: new Date() });
                batch.set(notificationRef, { recipientUid: inviteeUid, type: 'group_invitation', read: false, createdAt: new Date(), data: { invitationId: invitationRef.id, groupId: id, groupName: name, inviterName } });
                
                return batch.commit();
            });

            await Promise.all(invitationPromises);
            console.log("Successfully committed all Firestore batches for invitations.");
        }

        // ✅ Step 3: Create a consistent response object
        const ownerProfile = await getAuth().getUser(uid);
        const groupForClient = {
            id,
            name: newGroupForDb.name,
            owner: newGroupForDb.owner,
            members: [{ // Return members as an array of profiles
                uid: ownerProfile.uid,
                displayName: ownerProfile.displayName || null,
                photoURL: ownerProfile.photoURL || null,
            }],
        };
        
        return c.json(groupForClient);

    } catch (error) {
        // This will now catch errors from RTDB, Auth, or Firestore.
        console.error("❌ Failed to create group or send invitations:", error);
        return c.json({ error: 'An error occurred during group creation.' }, 500);
    }
});

export default route
