import { Hono } from 'hono';
import { FieldPath } from 'firebase-admin/firestore';
import { fs } from '@/utils/firebase';
import { auth } from '@/middleware/auth';
import { searchRecipes, searchUsers } from '@/utils/searchIndex';

const route = new Hono();
route.use('*', auth);

/**
 * GET /explore/search?q=<query>
 * Searches recipes and users.
 *
 * Backed by an in-memory index (utils/searchIndex.ts) rather than Algolia. The
 * response shape is unchanged, so the client needs no edits.
 *
 * Note there is no configuration to validate here any more. The previous
 * version threw at MODULE LOAD when its Algolia keys were missing, and
 * index.ts eagerly imports every file under api/**, so one absent search
 * credential stopped the entire API from booting — grocery lists and all.
 * Search failing should never have been able to do that.
 */
route.get('/', async (c) => {
  const query = c.req.query('q');

  if (!query || typeof query !== 'string' || query.trim() === '') {
    return c.json({ error: 'A search query `q` is required.' }, 400);
  }

  try {
    const [recipes, users] = await Promise.all([
      searchRecipes(query, 10),
      searchUsers(query, 3),
    ]);

    // Follower and recipe counts live on the Firestore user doc, not on the
    // searchable record, so they are merged in for the handful of hits we
    // actually return rather than held in the index.
    let enrichedUsers: any[] = users;
    if (users.length > 0) {
      const snap = await fs.collection('users')
        .where(FieldPath.documentId(), 'in', users.map((u) => u.objectID))
        .get();
      const counts = new Map<string, { followerCount: number; recipeCount: number }>();
      snap.forEach((doc) => {
        const d = doc.data();
        counts.set(doc.id, {
          followerCount: d.followerCount || 0,
          recipeCount: d.recipeCount || 0,
        });
      });
      enrichedUsers = users.map((u) => ({
        ...u,
        ...(counts.get(u.objectID) ?? { followerCount: 0, recipeCount: 0 }),
      }));
    }

    return c.json({ recipes, users: enrichedUsers });
  } catch (error) {
    console.error('Search failed:', error);
    return c.json({ error: 'Could not perform search.' }, 500);
  }
});

export default route;
