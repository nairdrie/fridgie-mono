import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { FieldPath } from 'firebase-admin/firestore';

type Data = Record<string, unknown>;
type PublicAuthRecord = { uid: string; displayName?: string; photoURL?: string; email?: string; phoneNumber?: string };
let documents = new Map<string, Data>();
let authUsers = new Map<string, PublicAuthRecord>();
let queries: { path: string; cursor?: string; limit: number; field: FieldPath }[] = [];
let followingReads: string[] = [];
let hydratedBatches: string[][] = [];
let transactions = 0;

const snapshot = (path: string) => ({
  id: path.split('/').at(-1)!,
  exists: documents.has(path),
  data: () => documents.get(path),
});
const documentRef = (path: string): any => ({
  path,
  id: path.split('/').at(-1),
  collection: (name: string) => collectionRef(`${path}/${name}`),
  get: async () => snapshot(path),
});
const collectionRef = (path: string): any => ({
  doc: (id: string) => documentRef(`${path}/${id}`),
  orderBy: (field: FieldPath) => queryRef(path, field),
});
const queryRef = (path: string, field: FieldPath, cursor?: string, limit = Infinity): any => ({
  startAfter: (value: string) => queryRef(path, field, value, limit),
  limit: (value: number) => queryRef(path, field, cursor, value),
  get: async () => {
    queries.push({ path, field, cursor, limit });
    const prefix = `${path}/`;
    const ids = [...documents.keys()]
      .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map(key => key.slice(prefix.length))
      .sort()
      .filter(id => cursor === undefined || id > cursor)
      .slice(0, limit);
    return { docs: ids.map(id => snapshot(`${prefix}${id}`)) };
  },
});

const fakeFirestore = {
  collection: (name: string) => collectionRef(name),
  getAll: async (...refs: { path: string }[]) => {
    followingReads.push(...refs.map(ref => ref.path));
    return refs.map(ref => snapshot(ref.path));
  },
  runTransaction: async (operation: (transaction: any) => Promise<void>) => {
    transactions++;
    const writes: (() => void)[] = [];
    await operation({
      getAll: async (...refs: { path: string }[]) => {
        // A mock with Firestore's real read-before-write constraint catches
        // accidental ordering changes in the route's transaction.
        if (writes.length) throw new Error('Transaction read after write');
        return refs.map(ref => snapshot(ref.path));
      },
      delete: (ref: { path: string }) => writes.push(() => { documents.delete(ref.path); }),
      set: (ref: { path: string }, value: Data, options?: { merge: boolean }) => writes.push(() => {
        documents.set(ref.path, options?.merge ? { ...documents.get(ref.path), ...value } : value);
      }),
    });
    writes.forEach(write => write());
  },
};

mock.module('../utils/firebase', () => ({
  fs: fakeFirestore,
  adminAuth: {
    verifyIdToken: async (token: string) => {
      if (token !== 'valid-token') throw new Error('Invalid token');
      return { uid: 'caller', firebase: { sign_in_provider: 'password' } };
    },
    getUser: async (uid: string) => {
      const user = authUsers.get(uid);
      if (!user) throw Object.assign(new Error('User not found'), { code: 'auth/user-not-found' });
      return user;
    },
    getUsers: async (ids: { uid: string }[]) => {
      hydratedBatches.push(ids.map(id => id.uid));
      // Auth's result ordering is not a contract; the route must restore the
      // Firestore order even when records are missing or returned differently.
      return {
        users: ids.map(({ uid }) => authUsers.get(uid)).filter(Boolean).reverse(),
        notFound: ids.filter(({ uid }) => !authUsers.has(uid)),
      };
    },
  },
}));

const connections = (await import('../api/user/[id]/connections')).default;
const removeFollower = (await import('../api/user/follower/[id]')).default;
const app = new Hono()
  .route('/api/user/:id/connections', connections)
  .route('/api/user/follower/:id', removeFollower);
const headers = { authorization: 'Bearer valid-token' };
const request = (path: string, init: RequestInit = {}) => app.request(path, { headers, ...init });
const user = (uid: string, fields: Omit<PublicAuthRecord, 'uid'> = {}) => authUsers.set(uid, { uid, ...fields });
const edge = (owner: string, kind: 'followers' | 'following', uid: string) => documents.set(`users/${owner}/${kind}/${uid}`, {});
const graph = (follower: string, owner: string) => { edge(owner, 'followers', follower); edge(follower, 'following', owner); };

beforeEach(() => {
  documents = new Map();
  authUsers = new Map();
  queries = [];
  followingReads = [];
  hydratedBatches = [];
  transactions = 0;
  user('caller');
  user('owner');
});

describe('GET user connections', () => {
  test('returns public fields in UID order and follow state relative to the caller', async () => {
    user('alice', { displayName: 'Alice', photoURL: 'https://images.test/alice', email: 'private@example.test', phoneNumber: '+15550000000' });
    user('bob');
    edge('owner', 'followers', 'bob');
    edge('owner', 'followers', 'alice');
    edge('caller', 'following', 'alice');
    edge('owner', 'following', 'bob');

    const response = await request('/api/user/owner/connections?kind=followers');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ users: [
      { uid: 'alice', displayName: 'Alice', photoURL: 'https://images.test/alice', isFollowing: true },
      { uid: 'bob', displayName: null, photoURL: null, isFollowing: false },
    ], nextCursor: null });
    expect(queries[0]!.field.isEqual(FieldPath.documentId())).toBe(true);
    expect(queries[0]!.limit).toBe(41);
    expect(followingReads).toEqual(['users/caller/following/alice', 'users/caller/following/bob']);
  });

  test('paginates following edges past deleted Auth users without skipping live users', async () => {
    for (const uid of ['a', 'b-deleted', 'c', 'd']) edge('owner', 'following', uid);
    for (const uid of ['a', 'c', 'd']) user(uid);
    const first = await request('/api/user/owner/connections?kind=following&limit=2');
    const page = await first.json();
    expect(page.users.map((record: any) => record.uid)).toEqual(['a']);
    expect(page.nextCursor).toBe('b-deleted');
    const second = await request(`/api/user/owner/connections?kind=following&limit=2&cursor=${page.nextCursor}`);
    expect(await second.json()).toEqual({ users: [
      { uid: 'c', displayName: null, photoURL: null, isFollowing: false },
      { uid: 'd', displayName: null, photoURL: null, isFollowing: false },
    ], nextCursor: null });
    expect(queries.map(query => query.path)).toEqual(['users/owner/following', 'users/owner/following']);
  });

  test('an entirely deleted page still advances, and a deleted cursor edge is supported', async () => {
    for (const uid of ['a', 'b', 'c']) edge('owner', 'followers', uid);
    user('c');
    const first = await request('/api/user/owner/connections?kind=followers&limit=2');
    expect(await first.json()).toEqual({ users: [], nextCursor: 'b' });
    documents.delete('users/owner/followers/b');
    const next = await request('/api/user/owner/connections?kind=followers&limit=2&cursor=b');
    expect((await next.json()).users.map((record: any) => record.uid)).toEqual(['c']);
  });

  test('clamps page sizes to 1..100 and never hydrates more than 100 Auth users', async () => {
    for (let index = 0; index < 102; index++) {
      const uid = `person-${String(index).padStart(3, '0')}`;
      edge('owner', 'followers', uid);
      user(uid);
    }
    const maximum = await request('/api/user/owner/connections?kind=followers&limit=200');
    const maximumPage = await maximum.json();
    expect(maximumPage.users).toHaveLength(100);
    expect(maximumPage.nextCursor).toBe('person-099');
    expect(queries[0]!.limit).toBe(101);
    expect(hydratedBatches[0]).toHaveLength(100);
    for (const limit of ['0', '-10']) {
      const minimum = await request(`/api/user/owner/connections?kind=followers&limit=${limit}`);
      expect((await minimum.json()).users).toHaveLength(1);
    }
  });

  test('empty collections and exhausted cursors return no continuation', async () => {
    for (const query of ['kind=followers', 'kind=following&cursor=z']) {
      const response = await request(`/api/user/owner/connections?${query}`);
      expect(await response.json()).toEqual({ users: [], nextCursor: null });
    }
    expect(hydratedBatches).toHaveLength(0);
  });

  test('requires authentication and rejects invalid queries before Firestore', async () => {
    for (const authorization of ['', 'Bearer invalid-token']) {
      const response = await app.request('/api/user/owner/connections?kind=followers', { headers: { authorization } });
      expect(response.status).toBe(401);
    }
    for (const query of ['', 'kind=friends', 'kind=followers&cursor=', 'kind=followers&cursor=a%2Fb', 'kind=followers&limit=', 'kind=followers&limit=1.5', 'kind=followers&limit=NaN']) {
      const response = await request(`/api/user/owner/connections?${query}`);
      expect(response.status).toBe(400);
    }
    for (const uid of ['a'.repeat(129), 'a%2Fb', '%20']) {
      const response = await request(`/api/user/${uid}/connections?kind=followers`);
      expect(response.status).toBe(400);
    }
    expect(queries).toHaveLength(0);
  });

  test('a deleted profile is a 404 even if its graph has stale edges', async () => {
    edge('deleted-owner', 'followers', 'alice');
    const response = await request('/api/user/deleted-owner/connections?kind=followers');
    expect(response.status).toBe(404);
    expect(queries).toHaveLength(0);
  });
});

describe('DELETE own follower', () => {
  test('removes both edges and decrements only the corresponding counters once', async () => {
    graph('alice', 'caller');
    graph('caller', 'alice'); // The caller's outgoing follow is independent.
    documents.set('users/caller', { followerCount: 3, followingCount: 7, untouched: 'keep' });
    documents.set('users/alice', { followingCount: 5, followerCount: 2 });

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request('/api/user/follower/alice', { method: 'DELETE' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
    }
    expect(documents.has('users/caller/followers/alice')).toBe(false);
    expect(documents.has('users/alice/following/caller')).toBe(false);
    expect(documents.has('users/caller/following/alice')).toBe(true);
    expect(documents.has('users/alice/followers/caller')).toBe(true);
    expect(documents.get('users/caller')).toEqual({ followerCount: 2, followingCount: 7, untouched: 'keep' });
    expect(documents.get('users/alice')).toEqual({ followingCount: 4, followerCount: 2 });
    expect(transactions).toBe(2);
  });

  test('only the authenticated caller owns the removal, ignoring another owner in the request', async () => {
    graph('alice', 'caller');
    graph('alice', 'owner');
    documents.set('users/caller', { followerCount: 1 });
    documents.set('users/owner', { followerCount: 1 });
    documents.set('users/alice', { followingCount: 2 });
    const response = await request('/api/user/follower/alice?ownerId=owner', {
      method: 'DELETE', body: JSON.stringify({ ownerId: 'owner' }),
    });
    expect(response.status).toBe(200);
    expect(documents.has('users/owner/followers/alice')).toBe(true);
    expect(documents.has('users/alice/following/owner')).toBe(true);
    expect(documents.get('users/owner')).toEqual({ followerCount: 1 });
    expect(documents.get('users/alice')).toEqual({ followingCount: 1 });
  });

  test('one-sided legacy edges only decrement the side that exists', async () => {
    edge('caller', 'followers', 'alice');
    documents.set('users/caller', { followerCount: 1 });
    documents.set('users/alice', { followingCount: 9 });
    await request('/api/user/follower/alice', { method: 'DELETE' });
    expect(documents.get('users/caller')).toEqual({ followerCount: 0 });
    expect(documents.get('users/alice')).toEqual({ followingCount: 9 });

    edge('bob', 'following', 'caller');
    documents.set('users/bob', { followingCount: 2 });
    await request('/api/user/follower/bob', { method: 'DELETE' });
    expect(documents.get('users/caller')).toEqual({ followerCount: 0 });
    expect(documents.get('users/bob')).toEqual({ followingCount: 1 });
  });

  test('deleted follower accounts can be removed without resurrecting profiles or negative counters', async () => {
    graph('deleted', 'caller');
    documents.set('users/caller', { followerCount: 0 });
    const response = await request('/api/user/follower/deleted', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(documents.has('users/deleted')).toBe(false);
    expect(documents.get('users/caller')).toEqual({ followerCount: 0 });
    expect(documents.has('users/caller/followers/deleted')).toBe(false);
    expect(documents.has('users/deleted/following/caller')).toBe(false);
  });

  test('removing a non-follower is an idempotent no-op for every counter', async () => {
    documents.set('users/caller', { followerCount: 4 });
    documents.set('users/stranger', { followingCount: 2 });
    await request('/api/user/follower/stranger', { method: 'DELETE' });
    expect(documents.get('users/caller')).toEqual({ followerCount: 4 });
    expect(documents.get('users/stranger')).toEqual({ followingCount: 2 });
  });

  test('requires authentication and rejects self-removal and malformed UIDs', async () => {
    const unauthorized = await app.request('/api/user/follower/alice', { method: 'DELETE' });
    expect(unauthorized.status).toBe(401);
    for (const uid of ['caller', 'a'.repeat(129), 'a%2Fb', '%00']) {
      const response = await request(`/api/user/follower/${uid}`, { method: 'DELETE' });
      expect(response.status).toBe(400);
    }
    expect(transactions).toBe(0);
  });
});
