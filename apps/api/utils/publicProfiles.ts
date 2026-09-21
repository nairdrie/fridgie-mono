import { adminAuth, fs } from './firebase';
import type { UserProfile } from './types';

/** Only explicit server-owned curated profiles acquire the editorial badge. */
export function curatedProfileFields(data: Record<string, any> = {}): Pick<UserProfile, 'profileKind' | 'handle' | 'bio' | 'specialty' | 'accent'> {
  if (data.profileKind !== 'curated') return { profileKind: 'community' };
  return {
    profileKind: 'curated',
    ...(typeof data.handle === 'string' ? { handle: data.handle.slice(0, 80) } : {}),
    ...(typeof data.bio === 'string' ? { bio: data.bio.slice(0, 1000) } : {}),
    ...(typeof data.specialty === 'string' ? { specialty: data.specialty.slice(0, 120) } : {}),
    ...(['sage', 'peach', 'lemon'].includes(data.accent) ? { accent: data.accent } : {}),
  };
}

export async function publicProfiles(uids: string[]): Promise<Map<string, UserProfile>> {
  const ids = [...new Set(uids.filter(uid => typeof uid === 'string' && !!uid))];
  const profiles = new Map<string, UserProfile>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const [auth, docs] = await Promise.all([
      adminAuth.getUsers(chunk.map(uid => ({ uid }))),
      fs.getAll(...chunk.map(uid => fs.collection('users').doc(uid))),
    ]);
    const records = new Map(auth.users.map(user => [user.uid, user]));
    for (const doc of docs) {
      const record = records.get(doc.id);
      const data = doc.data() ?? {};
      if (!record) continue;
      profiles.set(doc.id, {
        uid: doc.id,
        displayName: record.displayName ?? null,
        photoURL: record.photoURL ?? null,
        ...curatedProfileFields(data),
        followerCount: Math.max(0, Number(data.followerCount) || 0),
        followingCount: Math.max(0, Number(data.followingCount) || 0),
        recipeCount: Math.max(0, Number(data.recipeCount) || 0),
      });
    }
  }
  return profiles;
}
