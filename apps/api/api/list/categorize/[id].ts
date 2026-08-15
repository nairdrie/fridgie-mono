import { Hono } from 'hono';
import { adminRtdb } from '@/utils/firebase';
import { LexoRank } from 'lexorank';
import { v4 as uuid } from 'uuid';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';
import { mutateList } from '@/utils/listStore';

const route = new Hono();

route.use('*', auth, groupAuth)

const apiKey = process.env.OPENAI_API_KEY || Bun.env.OPENAI_API_KEY;
const openai = new OpenAI({
  apiKey
});

// Helper to normalize text for consistent cache keys
const normalizeItemText = (text: string) => {
  return text.toLowerCase().replace(/\s+/g, '');
};


// POST /api/lists/categorize/:id
route.post('/', async (c) => {
  const id = c.req.param('id');
  const groupId = c.req.query('groupId');
  if (!id) return c.text('Missing list ID', 400);

  let originalItems: any[] | undefined;
  // Blank placeholder rows (every list is created with one `text: ''` item) must
  // survive categorization without being treated as uncategorizable — otherwise
  // they get swept into a spurious "Other" section on every single run.
  let blankItems: any[] = [];

  const isReal = (i: any) => !i?.isSection && String(i?.text ?? '').trim() !== '';
  const isBlank = (i: any) => !i?.isSection && String(i?.text ?? '').trim() === '';

  // 1. Prefer items from the request body — they carry edits the client hasn't
  // saved yet. Accept a bare array too, since older clients POST it unwrapped.
  try {
    const body = await c.req.json();
    const bodyItems = Array.isArray(body) ? body : body?.items;
    if (Array.isArray(bodyItems)) {
      originalItems = bodyItems.filter(isReal);
      blankItems = bodyItems.filter(isBlank);
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
    originalItems = stored.filter(isReal);
    blankItems = stored.filter(isBlank);
  }

  // Both branches above assign it; this makes that provable to the compiler.
  const sourceItems: any[] = originalItems ?? [];

  // If there are no items to categorize, return the original list
  if (sourceItems.length === 0) {
    return c.json([...sourceItems, ...blankItems]);
  }

  // ✅ 3. Create a lookup map from the now-correctly-sourced items.
  const itemMap = new Map<string, any[]>();
  for (const item of sourceItems) {
    const key = String(item.text ?? '').toLowerCase();
    if (!itemMap.has(key)) {
      itemMap.set(key, []);
    }
    itemMap.get(key)?.push(item);
  }

  // --- The rest of the logic remains exactly the same ---

  const cacheRef = adminRtdb.ref('itemCategoryCache');
  const cacheSnap = await cacheRef.once('value');
  const cache: { [key: string]: string } = cacheSnap.val() || {};

  const itemsForAI: string[] = [];
  const allCategorizedItems = new Map<string, string[]>();

  for (const item of sourceItems) {
    const normalizedText = normalizeItemText(String(item.text ?? ''));
    const cachedCategory = cache[normalizedText];

    if (cachedCategory) {
      if (!allCategorizedItems.has(cachedCategory)) {
        allCategorizedItems.set(cachedCategory, []);
      }
      allCategorizedItems.get(cachedCategory)?.push(item.text);
    } else {
      itemsForAI.push(item.text);
    }
  }

  if (itemsForAI.length > 0) {
    const prompt = [
      `Group items:${JSON.stringify(itemsForAI)} into sections;`,
      `Return only raw JSON—no markdown, no code fences—of the form`,
      `{"sections":[{"name":string,"items":[string]}]}.`,
      `Use sections:Produce,Meat & Poultry,Seafood,Deli,Bakery,Dairy & Eggs,Frozen Foods,Pantry,Canned Goods,Baking,Beverages,Snacks & Candy,Health & Beauty,Household Essentials,Pet Supplies,International,Floral,Alcohol.`,
      `Only include sections that contain one or more items from the provided list.`
    ].join(' ');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
      console.error('LLM returned empty content');
      return c.text('Categorization failed: empty response', 500);
    }

    let parsed: { sections: { name: string; items: string[] }[] };
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.error('Failed to parse LLM JSON:', err);
      return c.text('Categorization failed: invalid JSON', 500);
    }

    const cacheUpdates: { [key: string]: string } = {};

    for (const sec of parsed.sections) {
      if (Array.isArray(sec.items) && sec.items.length > 0) {
        if (!allCategorizedItems.has(sec.name)) {
          allCategorizedItems.set(sec.name, []);
        }
        const existingItems = allCategorizedItems.get(sec.name)!;
        
        for (const itemText of sec.items) {
          existingItems.push(itemText);
          cacheUpdates[normalizeItemText(itemText)] = sec.name;
        }
      }
    }
    if (Object.keys(cacheUpdates).length > 0) {
      await cacheRef.update(cacheUpdates);
    }
  }
  
  let rank = LexoRank.middle();
  const newItems: any[] = [];
  
  const sortedCategories = Array.from(allCategorizedItems.keys()).sort();

  for (const categoryName of sortedCategories) {
    const itemsInSection = allCategorizedItems.get(categoryName)!;

    newItems.push({
      id: uuid(),
      text: categoryName,
      checked: false,
      isSection: true,
      listOrder: rank.toString(),
    });
    rank = rank.genNext();

    for (const text of itemsInSection) {
      const key = text.toLowerCase();
      const matchingItems = itemMap.get(key);

      if (matchingItems && matchingItems.length > 0) {
        const originalItem = matchingItems.shift();
        newItems.push({
          ...originalItem,
          listOrder: rank.toString(),
        });
        rank = rank.genNext();
      } else {
        console.warn(`Categorized item "${text}" could not be found in the original item map.`);
      }
    }
  }

  // Items the AI renamed or skipped never matched the map above; they must not
  // vanish from the user's list, so append them under an "Other" section.
  const leftovers: any[] = [];
  for (const remaining of itemMap.values()) {
    leftovers.push(...remaining);
  }
  if (leftovers.length > 0) {
    newItems.push({
      id: uuid(),
      text: 'Other',
      checked: false,
      isSection: true,
      listOrder: rank.toString(),
    });
    rank = rank.genNext();
    for (const item of leftovers) {
      newItems.push({ ...item, listOrder: rank.toString() });
      rank = rank.genNext();
    }
  }

  // Blank placeholder rows go back on the end, outside any section.
  for (const item of blankItems) {
    newItems.push({ ...item, listOrder: rank.toString() });
    rank = rank.genNext();
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