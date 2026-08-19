import { Hono } from 'hono';
import { adminRtdb } from '@/utils/firebase';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { mutateList } from '@/utils/listStore';
import { categorizeItems, isBlankItem, isRealItem } from '@/utils/categorize';

const route = new Hono();

// Deliberately NOT behind requireAccount. Sorting a list by aisle is the core
// of the grocery list, which is the one thing an anonymous install is meant to
// be able to do end to end; gating it made the Sort button silently no-op on
// any device that had not signed up. Cost is bounded by `itemCategoryCache` —
// repeat items never reach the model at all.
route.use('*', auth, groupAuth)

// POST /api/lists/categorize/:id
route.post('/', async (c) => {
  const id = c.req.param('id');
  const groupId = c.req.query('groupId');
  if (!id) return c.text('Missing list ID', 400);

  let originalItems: any[] | undefined;
  let blankItems: any[] = [];

  // 1. Prefer items from the request body — they carry edits the client hasn't
  // saved yet. Accept a bare array too, since older clients POST it unwrapped.
  try {
    const body = await c.req.json();
    const bodyItems = Array.isArray(body) ? body : body?.items;
    if (Array.isArray(bodyItems)) {
      originalItems = bodyItems.filter(isRealItem);
      blankItems = bodyItems.filter(isBlankItem);
    }
  } catch (e) {
    // Empty or invalid JSON body — fall through to the stored copy below.
  }

  // 2. Otherwise fall back to the database.
  if (!originalItems) {
    const snap = await adminRtdb.ref(`lists/${groupId}/${id}`).once('value');
    const list = snap.val();
    if (!list) return c.text('List not found', 404);
    const stored = Array.isArray(list.items) ? list.items : [];
    originalItems = stored.filter(isRealItem);
    blankItems = stored.filter(isBlankItem);
  }

  // Both branches above assign it; this makes that provable to the compiler.
  const sourceItems: any[] = originalItems ?? [];

  // Nothing to sort — hand the list straight back rather than writing it.
  if (sourceItems.length === 0) {
    return c.json([...sourceItems, ...blankItems]);
  }

  let newItems: any[];
  try {
    newItems = await categorizeItems(sourceItems, blankItems);
  } catch (err) {
    console.error('Categorization failed:', err);
    return c.text('Categorization failed', 500);
  }

  // Write through the shared list mutator so the doc's rev is bumped and
  // websocket consumers see this as a server-initiated change.
  //
  // `sort` is persisted here too: the client sets sort='category' locally after
  // calling this, but the very broadcast this write triggers would otherwise
  // reset it, since a server-initiated snapshot is always applied.
  const result = await mutateList(groupId!, id, (current) => ({
    ...current,
    items: newItems,
    sort: 'category',
  }));
  if (result.status === 'missing') return c.text('List not found', 404);
  return c.json(newItems);
});

export default route;
