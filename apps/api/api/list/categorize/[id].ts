import { Hono } from 'hono';
import { adminRtdb } from '@/utils/firebase';
import { LexoRank } from 'lexorank';
import { v4 as uuid } from 'uuid';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import { groupAuth } from '@/middleware/groupAuth';

const route = new Hono();

route.use('*', auth, groupAuth)

const openai = new OpenAI({
  apiKey: Bun.env.OPENAI_API_KEY
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

  // Fetch the current list
  const snap = await adminRtdb.ref(`lists/${groupId}/${id}`).once('value');
  const list = snap.val();
  if (!list) return c.text('List not found', 404);

  // ✅ 1. Get the FULL original items to preserve their data (id, checked, mealId, etc.)
  const originalItems = Array.isArray(list.items)
    ? list.items.filter((i: any) => !i.isSection)
    : [];
  
  const itemTextsForAI = originalItems.map((i: any) => i.text);

  // If there are no items to categorize, return the original list
  if (itemTextsForAI.length === 0) {
    return c.json(list.items || []);
  }
  
  // ✅ 2. Create a lookup map to easily find original items by their text.
  // This handles cases where you might have duplicate item names (e.g., "Milk" twice).
  const itemMap = new Map<string, any[]>();
  for (const item of originalItems) {
    const key = item.text.toLowerCase(); // Use lowercase for case-insensitive matching
    if (!itemMap.has(key)) {
      itemMap.set(key, []);
    }
    itemMap.get(key)?.push(item);
  }

  const cacheRef = adminRtdb.ref('itemCategoryCache');
  const cacheSnap = await cacheRef.once('value');
  const cache: { [key: string]: string } = cacheSnap.val() || {};

  const itemsForAI: string[] = [];
  const allCategorizedItems = new Map<string, string[]>(); // Map<Category, ItemText[]>

  // 1. Partition items into cached (known) and uncached (unknown)
  for (const item of originalItems) {
    const normalizedText = normalizeItemText(item.text);
    const cachedCategory = cache[normalizedText];

    if (cachedCategory) {
      // Item category is known, add it to our categorized map
      if (!allCategorizedItems.has(cachedCategory)) {
        allCategorizedItems.set(cachedCategory, []);
      }
      allCategorizedItems.get(cachedCategory)?.push(item.text);
    } else {
      // Item category is unknown, add it to the list for the LLM
      itemsForAI.push(item.text);
    }
  }

  // 2. Conditionally call the LLM only for unknown items
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

    // 3. Process LLM response, merge results, and prepare cache updates
    for (const sec of parsed.sections) {
      if (Array.isArray(sec.items) && sec.items.length > 0) {
        // Merge with existing categories
        if (!allCategorizedItems.has(sec.name)) {
          allCategorizedItems.set(sec.name, []);
        }
        const existingItems = allCategorizedItems.get(sec.name)!;
        
        for (const itemText of sec.items) {
          existingItems.push(itemText);
          // Prepare to update the cache for this new item
          cacheUpdates[normalizeItemText(itemText)] = sec.name;
        }
      }
    }

    // 4. Update the cache in a single batch operation
    if (Object.keys(cacheUpdates).length > 0) {
      await cacheRef.update(cacheUpdates);
    }
  }
  // highlight-end
  
  // --- Rebuild the List ---
  // This logic now works with the combined results from both cache and LLM

  let rank = LexoRank.middle();
  const newItems: any[] = [];
  
  // Sort sections alphabetically for a consistent user experience
  const sortedCategories = Array.from(allCategorizedItems.keys()).sort();

  for (const categoryName of sortedCategories) {
    const itemsInSection = allCategorizedItems.get(categoryName)!;

    // Add new section header
    newItems.push({
      id: uuid(),
      text: categoryName,
      checked: false,
      isSection: true,
      listOrder: rank.toString(),
    });
    rank = rank.genNext();

    // Find and place original items under the new section
    for (const text of itemsInSection) {
      const key = text.toLowerCase();
      const matchingItems = itemMap.get(key);
      
      if (matchingItems && matchingItems.length > 0) {
        const originalItem = matchingItems.shift(); // Handles duplicates
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

  // Persist updated items
  await adminRtdb.ref(`lists/${groupId}/${id}/items`).set(newItems);
  return c.json(newItems);
});

export default route;
