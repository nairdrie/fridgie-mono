import { Hono } from 'hono';
import { FieldValue } from 'firebase-admin/firestore';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';
import { discoverAdEventDay, validateDiscoverAdEvent } from '@/utils/discoverAdvertising';

const route = new Hono();
route.use('*', auth);
const MAX_EVENT_BODY_BYTES = 1_024;
const COUNTER_FIELD = {
  impression: 'impressions',
  click: 'clicks',
  hide: 'hides',
  report: 'reports',
} as const;

/**
 * POST /api/explore/ads/event
 * Body: { event: impression|click|hide|report, provider: house|admob }
 *
 * Authentication limits casual abuse, but the verified UID is intentionally
 * never read here: storage contains one daily counter per provider/action and
 * no user, recipe, search, household, or creative-level record.
 */
route.post('/', async (c) => {
  const declaredLength = Number(c.req.header('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EVENT_BODY_BYTES) {
    return c.json({ error: 'Advertising event body is too large.' }, 413);
  }
  const rawBody = await c.req.text().catch(() => '');
  if (new TextEncoder().encode(rawBody).byteLength > MAX_EVENT_BODY_BYTES) {
    return c.json({ error: 'Advertising event body is too large.' }, 413);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Invalid JSON and a structurally invalid event share one generic boundary.
  }
  const event = validateDiscoverAdEvent(body);
  if (!event) return c.json({ error: 'Invalid advertising event.' }, 400);

  try {
    const day = discoverAdEventDay();
    await fs.collection('discoveryAdMetrics').doc(day).set({
      schemaVersion: 1,
      day,
      counts: {
        [event.provider]: {
          [COUNTER_FIELD[event.event]]: FieldValue.increment(1),
        },
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return c.body(null, 204);
  } catch (error) {
    // Do not echo or persist raw SDK diagnostics. The request contains no raw
    // context either, but keeping this generic makes that invariant durable.
    console.error('Advertising aggregate write failed.');
    return c.json({ error: 'Could not record advertising event.' }, 500);
  }
});

export default route;
