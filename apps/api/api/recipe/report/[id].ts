import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import { fs } from '@/utils/firebase';
import {
  MAX_REPORT_NOTE_CHARS,
  isReportReason,
  reportRecipe,
} from '@/utils/moderation';

const route = new Hono();

// Reporting is an accusation that gets acted on automatically, so it is closed
// to the anonymous accounts the app hands out on first launch — otherwise the
// auto-hide threshold costs three taps and three fresh installs.
route.use('*', auth, requireAccount);

/**
 * POST /api/recipe/report/:id
 * Body: { reason: ReportReason, note?: string }
 *
 * Always hides the recipe for the caller. Pulls it from Explore and search once
 * enough different people have reported it — see utils/moderation.ts.
 */
route.post('/', async (c) => {
  const uid = c.get('uid') as string;
  const recipeId = c.req.param('id');
  if (!recipeId) {
    return c.json({ error: 'Missing recipe ID' }, 400);
  }

  const body = await c.req.json<{ reason?: string; note?: string }>().catch(() => null);
  const reason = body?.reason;
  if (!isReportReason(reason)) {
    return c.json({ error: 'A valid `reason` is required.' }, 400);
  }
  const note = typeof body?.note === 'string'
    ? body.note.trim().slice(0, MAX_REPORT_NOTE_CHARS)
    : '';

  const recipeDoc = await fs.collection('recipes').doc(recipeId).get();
  if (!recipeDoc.exists) {
    return c.json({ error: 'Recipe not found' }, 404);
  }

  // Reporting your own recipe is a no-op worth refusing plainly: the owner
  // already has a way to take it down, and letting it through would let someone
  // trip their own auto-hide from three accounts they control.
  if (recipeDoc.data()?.createdBy === uid) {
    return c.json({ error: 'You cannot report your own recipe. Make it private instead.' }, 400);
  }

  try {
    const outcome = await reportRecipe(
      uid,
      recipeId,
      reason,
      note,
      recipeDoc.data()?.sourceKey ?? null,
    );
    return c.json(outcome);
  } catch (error) {
    console.error('Recipe report failed:', error);
    return c.json({ error: 'Could not submit that report.' }, 500);
  }
});

export default route;
