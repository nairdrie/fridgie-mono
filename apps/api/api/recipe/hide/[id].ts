import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { hideRecipeForUser, unhideRecipeForUser } from '@/utils/moderation';

const route = new Hono();
route.use('*', auth);

/**
 * POST /api/recipe/hide/:id — never show me this one again.
 * DELETE /api/recipe/hide/:id — undo that.
 *
 * Personal and instant, with no claim attached and nothing to justify. Kept
 * apart from /report on purpose: collapsing "not for me" into "this is spam"
 * makes both signals useless, one by drowning it and the other by overstating
 * it.
 *
 * Deliberately no existence check on the recipe. This writes only to the
 * caller's own subcollection, and hiding an id that turns out to be deleted is
 * harmless — a read to confirm otherwise costs more than it protects.
 */
route.post('/', async (c) => {
  const uid = c.get('uid') as string;
  const recipeId = c.req.param('id');
  if (!recipeId) return c.json({ error: 'Missing recipe ID' }, 400);

  await hideRecipeForUser(uid, recipeId);
  return c.json({ hidden: true });
});

route.delete('/', async (c) => {
  const uid = c.get('uid') as string;
  const recipeId = c.req.param('id');
  if (!recipeId) return c.json({ error: 'Missing recipe ID' }, 400);

  await unhideRecipeForUser(uid, recipeId);
  return c.json({ hidden: false });
});

export default route;
