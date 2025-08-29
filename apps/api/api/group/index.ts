// api/group/index.ts
import { Hono } from 'hono'
import { adminRtdb, fs } from '../../utils/firebase'
import { v4 as uuid } from 'uuid'
import { auth } from '../../middleware/auth'
import { getAuth } from 'firebase-admin/auth';

// TODO: Centralize
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

// GET /api/groups
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

// POST /api/groups
route.post('/', async (c) => {
  const uid = c.get('uid') as string
  const { name, memberUids } = await c.req.json<{ name?: string, memberUids?: string[] }>()

  if (!name || typeof name !== 'string') {
    return c.json({ error: '`name` is required' }, 400)
  }

  const id = uuid()
  const newGroup: {name: string, owner: string, members: Record<string, boolean>, createdAt: number} = {
    name,
    owner: uid,
    members: {},
    createdAt: Date.now(),
  }

  if(memberUids && Array.isArray(memberUids)) {
    for (const memberUid of memberUids) {
      newGroup.members[memberUid] = true;
    }
  }

  // 5) write under this user’s node
  await adminRtdb.ref(`groups/${id}`).set(newGroup)

  return c.json({ id, ...newGroup })
})

export default route
