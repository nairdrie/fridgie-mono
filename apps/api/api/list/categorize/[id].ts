import { Hono } from 'hono';
import { adminRtdb } from '@/utils/firebase';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { mutateList } from '@/utils/listStore';
import { sanitizeItems } from '@/utils/rank';
import { categorizeItems, categorizeNewItems, isBlankItem, isRealItem } from '@/utils/categorize';
import { keepUnanswered } from '@/utils/sections';

const route = new Hono();

// Deliberately NOT behind requireAccount. Sorting a list by aisle is the core
// of the grocery list, which is the one thing an anonymous install is meant to
// be able to do end to end; gating it made the Sort button silently no-op on
// any device that had not signed up. Cost is bounded by `itemCategoryCache` —
// a repeat item, or any rewording of one, never reaches the model at all.
route.use('*', auth, groupAuth)

/**
 * POST /api/list/categorize/:id?groupId=...
 * Body: { items?: Item[], itemIds?: string[], clientId?: string }
 *
 * With `itemIds` this files just those items into their aisles and leaves the
 * rest of the list alone — the path every add takes, so it runs constantly and
 * must not reshuffle rows the user is not touching. Without them it re-sorts
 * the whole list, which is what the Sort by Category button asks for.
 *
 * The committed revision comes back in `X-List-Rev`, and the caller's
 * `clientId` is stamped on the write. Both exist because the caller already
 * holds the answer in this response: without them it would re-apply its own
 * broadcast and then save against a revision this write had already moved past,
 * losing anything typed while the request was in flight.
 */
route.post('/', async (c) => {
  const id = c.req.param('id');
  const groupId = c.req.query('groupId');
  if (!id) return c.text('Missing list ID', 400);

  let allItems: any[] | undefined;
  let itemIds: string[] | undefined;
  let clientId: string | undefined;

  // 1. Prefer items from the request body — they carry edits the client hasn't
  // saved yet. Accept a bare array too, since older clients POST it unwrapped.
  try {
    const body = await c.req.json();
    const bodyItems = Array.isArray(body) ? body : body?.items;
    if (Array.isArray(bodyItems)) allItems = sanitizeItems(bodyItems).items;
    if (Array.isArray(body?.itemIds)) {
      itemIds = body.itemIds.filter((v: unknown) => typeof v === 'string');
    }
    if (typeof body?.clientId === 'string') clientId = body.clientId;
  } catch (e) {
    // Empty or invalid JSON body — fall through to the stored copy below.
  }

  // 2. Otherwise fall back to the database.
  if (!allItems) {
    const snap = await adminRtdb.ref(`lists/${groupId}/${id}`).once('value');
    const list = snap.val();
    if (!list) return c.text('List not found', 404);
    allItems = sanitizeItems(list.items).items;
  }

  // Nothing to sort — hand the list straight back rather than writing it. An
  // empty `itemIds` is the same answer: it asks for nothing in particular to be
  // filed, which is not the same as asking for the whole list to be re-sorted.
  if (!allItems.some(isRealItem) || itemIds?.length === 0) return c.json(allItems);

  let newItems: any[];
  try {
    newItems = itemIds
      ? await categorizeNewItems(allItems, itemIds)
      : await categorizeItems(allItems.filter(isRealItem), allItems.filter(isBlankItem));
  } catch (err) {
    console.error('Categorization failed:', err);
    return c.text('Categorization failed', 500);
  }

  // Write through the shared list mutator so the doc's rev is bumped and the
  // change is broadcast to everyone else on the list.
  //
  // `sort` is persisted here too: the client sets sort='category' locally after
  // calling this, but the very broadcast this write triggers would otherwise
  // reset it, since that snapshot is always applied.
  //
  // The reconciliation runs INSIDE the transaction: categorizing takes a model
  // call, and a row another member added in that window is only visible on
  // `current`. Writing the answer over the top of it would delete their item.
  let committed = newItems;
  const result = await mutateList(groupId!, id, (current) => {
    committed = keepUnanswered(newItems, sanitizeItems(current.items).items);
    return { ...current, items: committed, sort: 'category' };
  }, { clientId });
  if (result.status === 'missing') return c.text('List not found', 404);

  // A header rather than a wrapped body: the response has always been a bare
  // items array and older installs still parse it as one.
  c.header('X-List-Rev', String(result.rev));
  return c.json(committed);
});

export default route;
