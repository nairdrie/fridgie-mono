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

// POST /api/lists/categorize/:id
route.post('/', async (c) => {
  const id = c.req.param('id');
  const groupId = c.req.query('groupId');
  if (!id) return c.text('Missing list ID', 400);

  // Fetch the current list
  const snap = await adminRtdb.ref(`lists/${groupId}/${id}`).once('value');
  const list = snap.val();
  if (!list) return c.text('List not found', 404);

  // Extract raw item texts (skip existing sections)
  const rawItems: string[] = Array.isArray(list.items)
    ? list.items
        .filter((i: any) => !i.isSection)
        .map((i: any) => i.text)
    : [];

  // Build LLM prompt
  const prompt = [
    `Group items:${JSON.stringify(rawItems)} into sections;`,
    `Return only raw JSON—no markdown, no code fences—of the form`,
    `{"sections":[{"name":string,"items":[string]}]}.`,
    `Use sections:Produce,Meat & Poultry,Seafood,Deli,Bakery,Dairy & Eggs,Frozen Foods,Pantry,Canned Goods,Baking,Beverages,Snacks & Candy,Health & Beauty,Household Essentials,Pet Supplies,International,Floral,Alcohol`
  ].join(' ');
  
  // Call the OpenAI API
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });

  // Safely extract content
  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    console.error('LLM returned empty content');
    return c.text('Categorization failed: empty response', 500);
  }
  console.log('LLM response:', content);
  // Parse the JSON response
  let parsed: { sections: { name: string; items: string[] }[] };
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error('Failed to parse LLM JSON:', err);
    return c.text('Categorization failed: invalid JSON', 500);
  }

  // Rebuild `items` array with sections + ranked items
  let rank = LexoRank.middle();
  const newItems: any[] = [];
  for (const sec of parsed.sections) {
    // Section header
    newItems.push({
      id: uuid(),
      text: sec.name,
      checked: false,
      isSection: true,
      order: rank.toString(),
    });
    rank = rank.genNext();

    // Individual items
    for (const text of sec.items) {
      newItems.push({
        id: uuid(),
        text,
        checked: false,
        isSection: false,
        order: rank.toString(),
      });
      rank = rank.genNext();
    }
  }

  // Persist updated items
  await adminRtdb.ref(`lists/${groupId}/${id}/items`).set(newItems);
  return c.json(newItems);
});

export default route;
