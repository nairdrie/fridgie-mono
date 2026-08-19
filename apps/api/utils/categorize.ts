import { LexoRank } from 'lexorank';
import { v4 as uuid } from 'uuid';
import { adminRtdb } from './firebase';
import { completeJson, models } from './claude';

/** Supermarket aisles, in the order they tend to appear. */
export const SECTIONS = [
  'Produce', 'Meat & Poultry', 'Seafood', 'Deli', 'Bakery', 'Dairy & Eggs',
  'Frozen Foods', 'Pantry', 'Canned Goods', 'Baking', 'Beverages',
  'Snacks & Candy', 'Health & Beauty', 'Household Essentials', 'Pet Supplies',
  'International', 'Floral', 'Alcohol',
] as const;

// An invented section name would fall through to the "Other" bucket below; as
// an enum the schema simply won't allow one.
const categorizationSchema = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: [...SECTIONS] },
          items: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'items'],
        additionalProperties: false,
      },
    },
  },
  required: ['sections'],
  additionalProperties: false,
} as const;

const categorizeSystemPrompt = `
You sort grocery items into supermarket sections.
Copy each item's text through to the output exactly as given — do not rename,
correct, pluralise, or tidy it. Every item must appear in exactly one section.
Only include sections that end up with at least one item.
`;

/** Normalizes text for consistent cache keys. */
const normalizeItemText = (text: string) => text.toLowerCase().replace(/\s+/g, '');

/** A real, categorizable row: not a section header, and not blank. */
export const isRealItem = (i: any) => !i?.isSection && String(i?.text ?? '').trim() !== '';

/**
 * Blank placeholder rows (every list is created with one `text: ''` item) must
 * survive categorization without being treated as uncategorizable — otherwise
 * they get swept into a spurious "Other" section on every single run.
 */
export const isBlankItem = (i: any) => !i?.isSection && String(i?.text ?? '').trim() === '';

/**
 * Sorts `sourceItems` into supermarket sections and returns a fresh, fully
 * ranked items array: a section header row followed by its members, sections
 * alphabetical, anything the model dropped under a trailing "Other", and the
 * blank placeholders last so they stay outside every section.
 *
 * Previously categorized items come back from `itemCategoryCache` for free;
 * only genuinely new text reaches the model. Existing item objects are carried
 * through untouched apart from `listOrder`, so quantities, `mealId` and
 * override fields all survive.
 *
 * Throws if the model call fails — callers decide whether that is fatal.
 */
export async function categorizeItems(
  sourceItems: any[],
  blankItems: any[] = [],
): Promise<any[]> {
  if (sourceItems.length === 0) return [...blankItems];

  // Lookup from item text back to the original objects. A list can legitimately
  // hold the same text twice (two meals both needing onions), so each key holds
  // a queue that is drained as the categorized names are matched back up.
  const itemMap = new Map<string, any[]>();
  for (const item of sourceItems) {
    const key = String(item.text ?? '').toLowerCase();
    if (!itemMap.has(key)) itemMap.set(key, []);
    itemMap.get(key)!.push(item);
  }

  const cacheRef = adminRtdb.ref('itemCategoryCache');
  const cacheSnap = await cacheRef.once('value');
  const cache: { [key: string]: string } = cacheSnap.val() || {};

  const itemsForAI: string[] = [];
  const allCategorizedItems = new Map<string, string[]>();

  for (const item of sourceItems) {
    const cachedCategory = cache[normalizeItemText(String(item.text ?? ''))];
    if (cachedCategory) {
      if (!allCategorizedItems.has(cachedCategory)) allCategorizedItems.set(cachedCategory, []);
      allCategorizedItems.get(cachedCategory)!.push(item.text);
    } else {
      itemsForAI.push(item.text);
    }
  }

  if (itemsForAI.length > 0) {
    const parsed: { sections: { name: string; items: string[] }[] } = await completeJson({
      model: models.categorize,
      system: categorizeSystemPrompt,
      user: `Sort these items:\n${JSON.stringify(itemsForAI)}`,
      schema: categorizationSchema,
      effort: 'low',
    });

    const cacheUpdates: { [key: string]: string } = {};

    for (const sec of parsed.sections) {
      if (!Array.isArray(sec.items) || sec.items.length === 0) continue;
      if (!allCategorizedItems.has(sec.name)) allCategorizedItems.set(sec.name, []);
      const existingItems = allCategorizedItems.get(sec.name)!;

      for (const itemText of sec.items) {
        existingItems.push(itemText);
        cacheUpdates[normalizeItemText(itemText)] = sec.name;
      }
    }
    if (Object.keys(cacheUpdates).length > 0) {
      await cacheRef.update(cacheUpdates);
    }
  }

  let rank = LexoRank.middle();
  const newItems: any[] = [];

  for (const categoryName of Array.from(allCategorizedItems.keys()).sort()) {
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
      const matchingItems = itemMap.get(text.toLowerCase());
      if (matchingItems && matchingItems.length > 0) {
        newItems.push({ ...matchingItems.shift(), listOrder: rank.toString() });
        rank = rank.genNext();
      } else {
        console.warn(`Categorized item "${text}" could not be found in the original item map.`);
      }
    }
  }

  // Items the model renamed or skipped never matched the map above; they must
  // not vanish from the user's list, so append them under an "Other" section.
  const leftovers: any[] = [];
  for (const remaining of itemMap.values()) leftovers.push(...remaining);
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

  return newItems;
}
