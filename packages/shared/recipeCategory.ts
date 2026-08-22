// What KIND of thing a recipe is — the shelf it sits on in a cookbook.
//
// Deliberately about the COURSE, not the ingredients and not the diet: `tags`
// already carries "vegan" and "italian", and neither of those answers "I want
// something for breakfast" or "show me the baking". A recipe has exactly one
// category, which is what makes it a filter chip rather than another tag.
//
// The vocabulary is CLOSED and lives here rather than on the server, because
// three parties have to agree on it: the model that assigns one (an enum in the
// JSON schema), the server that stores it, and the client that draws a chip per
// category. A category invented on any one of those sides is a chip nobody can
// ever select.
//
// Pure and environment-neutral, per packages/shared/README.md.

/**
 * Every category, in the order they are shown.
 *
 * Roughly the order of a meal rather than alphabetical — a cookbook's contents
 * page, not its index — with the fallback last.
 */
export const RECIPE_CATEGORIES = [
  'Breakfast',
  'Mains',
  'Sides',
  'Salads',
  'Soups & Stews',
  'Snacks & Appetizers',
  'Baked Goods',
  'Desserts',
  'Drinks',
  'Sauces & Dips',
  'Other',
] as const;

export type RecipeCategory = (typeof RECIPE_CATEGORIES)[number];

/**
 * Where anything unplaceable ends up. A real category — it gets a chip like the
 * rest — because a recipe with no category at all is a recipe the user can
 * never find again once they start filtering.
 */
export const FALLBACK_RECIPE_CATEGORY: RecipeCategory = 'Other';

/** Display order, for sorting a set of categories that arrived in any order. */
export const categoryOrder = (category: string): number => {
  const index = (RECIPE_CATEGORIES as readonly string[]).indexOf(category);
  return index === -1 ? RECIPE_CATEGORIES.length : index;
};

/** Lowercase, `&` spelled out, punctuation flattened: `"Soups & Stews"` -> `"soups and stews"`. */
const flatten = (value: string): string =>
  value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The words other people use for our categories.
 *
 * Every one of these has a real source: a site's own `recipeKeywords`, a model
 * that answered "Dessert" when the enum said "Desserts", a recipe imported
 * before this vocabulary existed. Mapping them beats dropping them on the floor
 * and re-asking a model what "Main Course" means.
 */
const SYNONYMS: Record<string, RecipeCategory> = {
  breakfast: 'Breakfast',
  brunch: 'Breakfast',
  main: 'Mains',
  mains: 'Mains',
  'main course': 'Mains',
  'main courses': 'Mains',
  'main dish': 'Mains',
  'main dishes': 'Mains',
  dinner: 'Mains',
  dinners: 'Mains',
  lunch: 'Mains',
  supper: 'Mains',
  entree: 'Mains',
  entrees: 'Mains',
  side: 'Sides',
  'side dish': 'Sides',
  'side dishes': 'Sides',
  salad: 'Salads',
  soup: 'Soups & Stews',
  soups: 'Soups & Stews',
  stew: 'Soups & Stews',
  stews: 'Soups & Stews',
  snack: 'Snacks & Appetizers',
  snacks: 'Snacks & Appetizers',
  appetizer: 'Snacks & Appetizers',
  appetizers: 'Snacks & Appetizers',
  appetiser: 'Snacks & Appetizers',
  appetisers: 'Snacks & Appetizers',
  starter: 'Snacks & Appetizers',
  starters: 'Snacks & Appetizers',
  'baked good': 'Baked Goods',
  baking: 'Baked Goods',
  bakery: 'Baked Goods',
  bread: 'Baked Goods',
  breads: 'Baked Goods',
  dessert: 'Desserts',
  sweets: 'Desserts',
  drink: 'Drinks',
  beverage: 'Drinks',
  beverages: 'Drinks',
  cocktail: 'Drinks',
  cocktails: 'Drinks',
  sauce: 'Sauces & Dips',
  sauces: 'Sauces & Dips',
  dip: 'Sauces & Dips',
  dips: 'Sauces & Dips',
  dressing: 'Sauces & Dips',
  dressings: 'Sauces & Dips',
  condiment: 'Sauces & Dips',
  condiments: 'Sauces & Dips',
  uncategorized: 'Other',
  uncategorised: 'Other',
  misc: 'Other',
  miscellaneous: 'Other',
};

const BY_FLAT_NAME = new Map<string, RecipeCategory>([
  ...RECIPE_CATEGORIES.map((c) => [flatten(c), c] as [string, RecipeCategory]),
  ...Object.entries(SYNONYMS).map(([k, v]) => [flatten(k), v] as [string, RecipeCategory]),
]);

/**
 * A stored or model-supplied value read back as one of ours, or null if it is
 * nothing we recognise.
 *
 * Null rather than 'Other' on purpose: the caller has to be able to tell "this
 * recipe genuinely didn't fit anywhere" from "this string is junk and the
 * recipe still needs categorizing".
 */
export function normalizeRecipeCategory(value: unknown): RecipeCategory | null {
  if (typeof value !== 'string') return null;
  const flat = flatten(value);
  if (!flat) return null;
  return BY_FLAT_NAME.get(flat) ?? null;
}

/** What a guess needs to see. Nothing here is required — an untitled recipe is guessable at 0%. */
export interface CategorizableRecipe {
  name?: string;
  description?: string;
  tags?: string[];
}

/**
 * Name-based rules, MOST SPECIFIC FIRST — the order is the whole design.
 *
 * "Chicken noodle soup" and "chicken salad" both contain "chicken"; they are
 * only filed correctly because Soups and Salads are consulted before Mains.
 * Every rule below therefore has to be readable as "if this word is in the
 * title, that beats anything further down the list".
 *
 * Kept deliberately small and high-precision. This is a FREE fast path in front
 * of a model call, not a replacement for one: a title that matches nothing here
 * is a title worth spending a Haiku call on, and a bad guess here is worse than
 * no guess at all because it is what gets stored.
 */
const NAME_RULES: [RecipeCategory, string[]][] = [
  // Savoury pies, ahead of the word "pie" itself. Shepherd's pie is dinner and
  // nobody has ever thought otherwise, but "pie" is a dessert word, so without
  // this the most-specific-first ordering files it under Desserts.
  ['Mains', [
    "shepherd's pie", 'shepherds pie', 'cottage pie', 'pot pie', 'meat pie',
    'steak pie', 'chicken pie', 'fish pie', 'tourtiere', 'empanada', 'empanadas',
  ]],
  // Bread by construction, but nobody browses the baking for it.
  ['Sides', ['garlic bread']],
  ['Drinks', [
    'smoothie', 'milkshake', 'juice', 'lemonade', 'cocktail', 'mocktail',
    'margarita', 'martini', 'mojito', 'sangria', 'punch', 'latte', 'iced coffee',
    'hot chocolate', 'hot cocoa', 'iced tea', 'kombucha', 'spritz', 'eggnog',
  ]],
  ['Desserts', [
    'cake', 'cupcake', 'cookie', 'cookies', 'brownie', 'brownies', 'blondie',
    'pie', 'tart', 'cheesecake', 'pudding', 'ice cream', 'gelato', 'sorbet',
    'mousse', 'trifle', 'fudge', 'custard', 'crumble', 'cobbler', 'dessert',
    'truffle', 'truffles', 'macaron', 'macaroon', 'doughnut', 'donut', 'sundae',
    'parfait', 'panna cotta', 'tiramisu', 'baklava', 'churro', 'churros', 'flan',
  ]],
  ['Baked Goods', [
    'bread', 'loaf', 'sourdough', 'focaccia', 'bagel', 'bagels', 'brioche',
    'cinnamon roll', 'cinnamon rolls', 'dinner roll', 'dinner rolls',
    'bun', 'buns', 'muffin', 'muffins', 'scone', 'scones',
    'biscuit', 'biscuits', 'croissant', 'croissants', 'cornbread', 'pretzel',
    'pretzels', 'naan', 'pita', 'crackers', 'danish', 'dough', 'babka', 'challah',
  ]],
  ['Soups & Stews', [
    'soup', 'stew', 'chowder', 'broth', 'bisque', 'chili', 'chilli', 'ramen',
    'pho', 'gumbo', 'minestrone', 'goulash', 'cassoulet',
  ]],
  ['Salads', ['salad', 'slaw', 'coleslaw', 'tabbouleh', 'panzanella']],
  ['Sauces & Dips', [
    'sauce', 'dressing', 'marinade', 'pesto', 'salsa', 'chutney', 'aioli', 'dip',
    'hummus', 'guacamole', 'gravy', 'jam', 'relish', 'tapenade', 'compote',
  ]],
  ['Breakfast', [
    'pancake', 'pancakes', 'waffle', 'waffles', 'omelette', 'omelet', 'frittata',
    'granola', 'oatmeal', 'porridge', 'overnight oats', 'french toast',
    'breakfast', 'brunch', 'shakshuka', 'hash browns', 'scrambled eggs',
    'eggs benedict', 'congee',
  ]],
  ['Snacks & Appetizers', [
    'snack', 'appetizer', 'appetiser', 'starter', 'canape', 'canapes', 'bites',
    'wings', 'nachos', 'popcorn', 'trail mix', 'energy balls', 'bruschetta',
    'deviled eggs', 'devilled eggs', 'jerky',
  ]],
  ['Sides', [
    'side', 'mashed potato', 'mashed potatoes', 'roast potatoes', 'fries',
    'stuffing', 'pilaf', 'baked beans',
  ]],
  ['Mains', [
    'pasta', 'spaghetti', 'lasagna', 'lasagne', 'risotto', 'curry', 'stir fry',
    'stir-fry', 'taco', 'tacos', 'burger', 'burgers', 'pizza', 'casserole',
    'roast', 'sandwich', 'wrap', 'burrito', 'enchilada', 'enchiladas',
    'meatball', 'meatballs', 'meatloaf', 'steak', 'schnitzel', 'stroganoff',
    'fajitas', 'quesadilla', 'paella', 'carbonara',
    'bolognese', 'katsu', 'tikka masala', 'fried rice', 'noodles', 'sheet pan',
    'wraps',
    'salmon', 'chicken', 'beef', 'pork', 'lamb', 'shrimp', 'prawn', 'tofu',
  ]],
];

/** Cached so a cookbook of 200 recipes builds these once rather than per recipe. */
const NAME_PATTERNS: [RecipeCategory, RegExp][] = NAME_RULES.map(([category, words]) => [
  category,
  // Flattened text has no punctuation left, so `\b` around a flattened keyword
  // matches whole words only: "pie" hits "apple pie" and not "pierogi".
  new RegExp(`\\b(?:${words.map((w) => flatten(w).replace(/ /g, '\\s+')).join('|')})\\b`),
]);

/**
 * Phrases that state the course outright, for the description pass.
 *
 * Everything here is something a writer only says about the dish in front of
 * them: nobody describes a curry as "a weeknight dessert". Same
 * most-specific-first ordering, same right to be missing — Mains has no entry
 * because there is no phrase a main course declares itself with.
 */
const DESCRIPTION_PATTERNS: [RecipeCategory, RegExp][] = ([
  ['Drinks', ['cocktail', 'mocktail', 'refreshing drink', 'summer drink']],
  ['Desserts', ['dessert', 'sweet treat', 'after dinner treat']],
  ['Baked Goods', ['freshly baked', 'straight from the oven']],
  ['Breakfast', ['for breakfast', 'breakfast', 'brunch']],
  ['Snacks & Appetizers', ['appetizer', 'appetiser', 'party snack', 'snack', 'finger food']],
  ['Sides', ['side dish', 'serves as a side']],
] as [RecipeCategory, string[]][]).map(([category, phrases]) => [
  category,
  new RegExp(`\\b(?:${phrases.map((p) => flatten(p).replace(/ /g, '\\s+')).join('|')})\\b`),
]);

/**
 * A category from the recipe's own words, or null when nothing is sure enough.
 *
 * Null is a perfectly good answer and the common one for anything with a
 * proper name ("Nonna's Sunday Gravy", "Bibimbap"). Callers with a model
 * available should ask it; callers without one should leave the recipe
 * uncategorized rather than storing a coin flip.
 */
export function guessRecipeCategory(recipe: CategorizableRecipe): RecipeCategory | null {
  const name = flatten(String(recipe?.name ?? ''));
  if (name) {
    for (const [category, pattern] of NAME_PATTERNS) {
      if (pattern.test(name)) return category;
    }
  }

  // Then the description, but only for words that DECLARE what the dish is.
  // Descriptions are chatty and full of other courses — "serve with a green
  // salad", "finish with a sauce" — so the ingredient-ish and dish-ish words
  // that work on a title are actively wrong here. "A summer dessert" is not.
  const description = flatten(String(recipe?.description ?? ''));
  if (description) {
    for (const [category, pattern] of DESCRIPTION_PATTERNS) {
      if (pattern.test(description)) return category;
    }
  }

  return null;
}
