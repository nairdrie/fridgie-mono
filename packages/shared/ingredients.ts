// Ingredient knowledge the quantity engine needs to combine measurements that
// aren't directly convertible. Environment-neutral, no dependencies.
//
// Two problems this solves:
//
//   1. "1 cup flour" + "10 g flour" — volume and mass can't be converted without
//      knowing the ingredient's density, so these used to be shown as separate
//      terms forever.
//   2. "2 cloves garlic" + "5-10 cloves" — countable things must never be
//      converted to grams; "230 g of garlic" is not a useful grocery line.

/** Words that describe preparation, not quantity. Never treat these as units. */
export const PREP_WORDS = new Set([
  'minced', 'mince', 'chopped', 'chop', 'diced', 'dice', 'sliced', 'slice',
  'grated', 'grate', 'shredded', 'shred', 'crushed', 'crush', 'ground',
  'melted', 'melt', 'softened', 'soften', 'beaten', 'beat', 'whisked',
  'peeled', 'peel', 'cubed', 'cube', 'julienned', 'halved', 'quartered',
  'divided', 'packed', 'sifted', 'drained', 'rinsed', 'trimmed', 'seeded',
  'cooked', 'uncooked', 'raw', 'fresh', 'freshly', 'frozen', 'canned', 'dried',
  'finely', 'roughly', 'coarsely', 'thinly', 'thickly', 'lightly',
  'optional', 'plus', 'more', 'extra', 'room', 'temperature', 'warm', 'cold',
  'large', 'small', 'medium', 'ripe', 'whole',
]);

/**
 * Grams per US cup. Sourced from standard baking references; these are the
 * figures cookbooks use, not lab densities — which is what we want, since the
 * input is recipe text.
 *
 * Keys are matched as substrings against the normalized ingredient name, longest
 * first, so "brown sugar" wins over "sugar" and "almond flour" over "flour".
 */
export const GRAMS_PER_CUP: Record<string, number> = {
  // flours & starches
  'almond flour': 96,
  'bread flour': 127,
  'whole wheat flour': 120,
  'self-raising flour': 125,
  'self raising flour': 125,
  'all-purpose flour': 120,
  'all purpose flour': 120,
  'plain flour': 120,
  'flour': 120,
  'cornstarch': 128,
  'cornflour': 128,
  'cornmeal': 157,
  'breadcrumbs': 108,
  'bread crumbs': 108,
  // sugars & sweeteners
  'powdered sugar': 120,
  'icing sugar': 120,
  'confectioners sugar': 120,
  'brown sugar': 220,
  'caster sugar': 200,
  'granulated sugar': 200,
  'sugar': 200,
  'honey': 340,
  'maple syrup': 322,
  'molasses': 337,
  // fats & dairy
  'butter': 227,
  'margarine': 227,
  'olive oil': 216,
  'vegetable oil': 218,
  'coconut oil': 218,
  'oil': 218,
  'heavy cream': 238,
  'double cream': 238,
  'sour cream': 230,
  'cream cheese': 232,
  'yogurt': 245,
  'yoghurt': 245,
  'milk': 244,
  'buttermilk': 245,
  'water': 237,
  'stock': 240,
  'broth': 240,
  // grains, legumes, nuts
  'rolled oats': 90,
  'oats': 90,
  'rice': 185,
  'quinoa': 170,
  'couscous': 173,
  'lentils': 192,
  'chickpeas': 164,
  'black beans': 172,
  'almonds': 143,
  'walnuts': 117,
  'pecans': 109,
  'peanuts': 146,
  'chocolate chips': 170,
  'raisins': 145,
  // savoury
  'parmesan': 100,
  'cheddar': 113,
  'cheese': 113,
  'salt': 273,
  'cocoa powder': 85,
  'cocoa': 85,
  'peanut butter': 258,
  'tomato sauce': 245,
  'ketchup': 240,
  'mayonnaise': 220,
  'soy sauce': 255,
};

/**
 * Units that denote a count of discrete things. These are never converted to
 * mass or volume, and they combine only with each other.
 */
export const COUNT_UNITS = new Set([
  'clove', 'cloves', 'head', 'heads', 'bunch', 'bunches', 'sprig', 'sprigs',
  'stalk', 'stalks', 'stick', 'sticks', 'slice', 'slices', 'piece', 'pieces',
  'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'packet', 'packets',
  'package', 'packages', 'pack', 'packs', 'bag', 'bags', 'box', 'boxes',
  'egg', 'eggs', 'leaf', 'leaves', 'ear', 'ears', 'fillet', 'fillets',
  'breast', 'breasts', 'thigh', 'thighs', 'rasher', 'rashers',
  'handful', 'handfuls', 'pinch', 'pinches', 'dash', 'dashes', 'drop', 'drops',
]);

/** Ingredients bought as whole items — a bare count means "this many of them". */
const COUNTABLE_INGREDIENTS = [
  'garlic', 'onion', 'shallot', 'egg', 'lemon', 'lime', 'orange', 'apple',
  'banana', 'avocado', 'potato', 'tomato', 'carrot', 'pepper', 'chilli',
  'chili', 'cucumber', 'zucchini', 'courgette', 'eggplant', 'aubergine',
  'bay leaf', 'cinnamon stick', 'tortilla', 'bun', 'roll', 'baguette',
];

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();

/** Grams per cup for an ingredient, or null when we don't know it. */
export function gramsPerCup(ingredientName?: string | null): number | null {
  if (!ingredientName) return null;
  const name = normalize(ingredientName);
  if (!name) return null;

  // Longest key first so "brown sugar" beats "sugar".
  const keys = Object.keys(GRAMS_PER_CUP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (name.includes(key)) return GRAMS_PER_CUP[key]!;
  }
  return null;
}

/** True when the ingredient is normally bought and counted as whole items. */
export function isCountableIngredient(ingredientName?: string | null): boolean {
  if (!ingredientName) return false;
  const name = normalize(ingredientName);
  return COUNTABLE_INGREDIENTS.some((k) => name.includes(k));
}

export function isCountUnit(unit?: string | null): boolean {
  return !!unit && COUNT_UNITS.has(unit.toLowerCase());
}

export function isPrepWord(token?: string | null): boolean {
  return !!token && PREP_WORDS.has(token.toLowerCase());
}
