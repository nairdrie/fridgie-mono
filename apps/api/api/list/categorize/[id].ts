import { Hono } from 'hono';
import { adminRtdb } from '@/utils/firebase';
import { LexoRank } from 'lexorank';
import { v4 as uuid } from 'uuid';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';

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

  let originalItems: any[];

  // ✅ 1. Try to get items from the request body first to avoid race conditions.
  try {
    const body = await c.req.json();
    if (body && Array.isArray(body.items)) {
      // If items are provided in the body, use them as the source of truth.
      originalItems = body.items.filter((i: any) => !i.isSection);
    }
  } catch (e) {
    // This will catch errors if the body is empty or not valid JSON.
    // We'll proceed to fetch from the database in the 'else' block below.
  }

  // ✅ 2. If items were not in the body, fall back to fetching from the database.
  // @ts-ignore - This check is valid as originalItems would be unassigned.
  if (!originalItems) {
    const snap = await adminRtdb.ref(`lists/${groupId}/${id}`).once('value');
    const list = snap.val();
    if (!list) return c.text('List not found', 404);
    originalItems = Array.isArray(list.items)
      ? list.items.filter((i: any) => !i.isSection)
      : [];
  }
  
  // If there are no items to categorize, return the original list
  if (originalItems.length === 0) {
    return c.json(originalItems);
  }
  
  // ✅ 3. Create a lookup map from the now-correctly-sourced originalItems.
  const itemMap = new Map<string, any[]>();
  for (const item of originalItems) {
    const key = item.text.toLowerCase();
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

  for (const item of originalItems) {
    const normalizedText = normalizeItemText(item.text);
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

  await adminRtdb.ref(`lists/${groupId}/${id}/items`).set(newItems);
  return c.json(newItems);
});

export default route;