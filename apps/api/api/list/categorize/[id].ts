import { Hono } from 'hono';
import { adminRtdb } from '../../../utils/firebase';
import { LexoRank } from 'lexorank';
import { v4 as uuid } from 'uuid';
import OpenAI from 'openai';
import { auth } from '../../../middleware/auth';
import { groupAuth } from '../../../middleware/groupAuth';

const route = new Hono();

route.use('*', auth, groupAuth)

const openai = new OpenAI({
  apiKey: Bun.env.OPENAI_API_KEY
});

// TODO: CHECK DB BEFORE LLM QUERY

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

  // Build LLM prompt (remains the same)
  const prompt = [
    `Group items:${JSON.stringify(itemTextsForAI)} into sections;`,
    `Return only raw JSON—no markdown, no code fences—of the form`,
    `{"sections":[{"name":string,"items":[string]}]}.`,
    `Use sections:Produce,Meat & Poultry,Seafood,Deli,Bakery,Dairy & Eggs,Frozen Foods,Pantry,Canned Goods,Baking,Beverages,Snacks & Candy,Health & Beauty,Household Essentials,Pet Supplies,International,Floral,Alcohol.`,
    `Only include sections that contain one or more items from the provided list.`
  ].join(' ');
  
  // Call the OpenAI API (remains the same)
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

  // ✅ Guard against empty sections returned by the AI
  const nonEmptySections = parsed.sections.filter(
    sec => Array.isArray(sec.items) && sec.items.length > 0
  );

  // ✅ 3. Rebuild the `newItems` array by finding original items and updating their listOrder
  let rank = LexoRank.middle();
  const newItems: any[] = [];
  for (const sec of nonEmptySections) {
    // Add new section header
    newItems.push({
      id: uuid(),
      text: sec.name,
      checked: false,
      isSection: true,
      listOrder: rank.toString(), // Use listOrder
    });
    rank = rank.genNext();

    // Find and place original items under the new section
    for (const text of sec.items) {
      const key = text.toLowerCase();
      const matchingItems = itemMap.get(key);
      
      // If a match is found, take the first one off the list and use it
      if (matchingItems && matchingItems.length > 0) {
        const originalItem = matchingItems.shift(); // Use shift() to handle duplicates correctly
        newItems.push({
          ...originalItem, // <-- This preserves id, text, checked, mealId, mealOrder, etc.
          listOrder: rank.toString(), // <-- Only the listOrder is updated
        });
        rank = rank.genNext();
      } else {
        // This can happen if the AI hallucinates an item that wasn't in the original list.
        // It's safest to just log it and move on.
        console.warn(`AI returned item "${text}" which was not in the original list or was a duplicate.`);
      }
    }
  }

  // Persist updated items
  await adminRtdb.ref(`lists/${groupId}/${id}/items`).set(newItems);
  return c.json(newItems);
});

export default route;
