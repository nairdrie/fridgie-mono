// Searching, filtering and ordering a cookbook.
//
// Pure, and separate from the components, because three screens show the same
// shelf — your own profile, somebody else's, and the picker that drops a recipe
// into a meal plan — and they had three different ideas of what "search" meant.
// One of them matched the name only, so a recipe you could see under a tag chip
// vanished when you typed that same tag.

import { Recipe } from '@/types/types';
import {
  FALLBACK_RECIPE_CATEGORY,
  categoryOrder,
  normalizeRecipeCategory,
  type RecipeCategory,
} from '@fridgie/shared/recipeCategory';

/** The pseudo-category for "don't filter at all". Not a shelf; a chip. */
export const ALL_CATEGORIES = 'All';

export type CategoryFilter = RecipeCategory | typeof ALL_CATEGORIES;

export type CookbookSort = 'recent' | 'name' | 'category';

export const COOKBOOK_SORTS: { key: CookbookSort; label: string }[] = [
  { key: 'recent', label: 'Recently added' },
  { key: 'name', label: 'A–Z' },
  { key: 'category', label: 'By category' },
];

export const sortLabel = (sort: CookbookSort): string =>
  COOKBOOK_SORTS.find((s) => s.key === sort)?.label ?? COOKBOOK_SORTS[0].label;

/**
 * The shelf a recipe appears on.
 *
 * A recipe with no category — one saved before categories existed, or one the
 * server hasn't filed yet — reads as 'Other' rather than as nothing at all.
 * Otherwise the counts wouldn't add up to the cookbook, and a recipe could be
 * invisible under every single chip.
 */
export const recipeCategory = (recipe: Recipe): RecipeCategory =>
  normalizeRecipeCategory(recipe?.category) ?? FALLBACK_RECIPE_CATEGORY;

/** Everything about a recipe worth typing into a search box. */
export function matchesSearch(recipe: Recipe, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return (
    (recipe.name ?? '').toLowerCase().includes(needle) ||
    (recipe.description ?? '').toLowerCase().includes(needle) ||
    recipeCategory(recipe).toLowerCase().includes(needle) ||
    (recipe.tags ?? []).some((tag) => (tag ?? '').toLowerCase().includes(needle))
  );
}

export interface CategoryChip {
  key: CategoryFilter;
  label: string;
  count: number;
}

/**
 * The chips to draw, in menu order, with "All" first.
 *
 * Counts are of what the SEARCH has already left, so the chips answer "what
 * else matches what I typed" rather than restating the whole cookbook. A
 * category with nothing in it gets no chip — with one exception: the selected
 * one always keeps its chip, because a filter you can see is a filter you can
 * turn off, and one that silently disappeared would leave the list looking
 * empty for no visible reason.
 */
export function categoryChips(recipes: Recipe[], selected: CategoryFilter): CategoryChip[] {
  const counts = new Map<RecipeCategory, number>();
  for (const recipe of recipes) {
    const category = recipeCategory(recipe);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (selected !== ALL_CATEGORIES && !counts.has(selected)) counts.set(selected, 0);

  const chips: CategoryChip[] = [...counts]
    .sort(([a], [b]) => categoryOrder(a) - categoryOrder(b))
    .map(([category, count]) => ({ key: category, label: category, count }));

  // Only one shelf in use is not a shelf worth choosing between.
  if (chips.length < 2 && selected === ALL_CATEGORIES) return [];

  return [{ key: ALL_CATEGORIES, label: 'All', count: recipes.length }, ...chips];
}

const byName = (a: Recipe, b: Recipe) =>
  (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' });

/**
 * A sorted copy. Never sorts in place — these arrays are React state owned by
 * whoever fetched them.
 *
 * 'recent' leans on `addedAt`, the moment this user shelved the recipe, and
 * falls back to the order the server sent for anything that hasn't got one
 * (a recipe shelved seconds ago, before its server timestamp resolves).
 */
export function sortRecipes(recipes: Recipe[], sort: CookbookSort): Recipe[] {
  const given = new Map(recipes.map((recipe, index) => [recipe.id, index]));
  const position = (recipe: Recipe) => given.get(recipe.id) ?? 0;
  const shelved = (recipe: Recipe) => (recipe.addedAt ? Date.parse(recipe.addedAt) : NaN);

  const sorted = [...recipes];
  if (sort === 'name') return sorted.sort(byName);
  if (sort === 'category') {
    return sorted.sort(
      (a, b) => categoryOrder(recipeCategory(a)) - categoryOrder(recipeCategory(b)) || byName(a, b),
    );
  }

  return sorted.sort((a, b) => {
    const [left, right] = [shelved(a), shelved(b)];
    if (Number.isNaN(left) || Number.isNaN(right)) return position(a) - position(b);
    return right - left;
  });
}

export interface CookbookFilters {
  searchTerm: string;
  category: CategoryFilter;
  sort: CookbookSort;
}

export function filterCookbook(recipes: Recipe[], filters: CookbookFilters): Recipe[] {
  const matching = recipes.filter(
    (recipe) =>
      matchesSearch(recipe, filters.searchTerm) &&
      (filters.category === ALL_CATEGORIES || recipeCategory(recipe) === filters.category),
  );
  return sortRecipes(matching, filters.sort);
}

export type CookbookRow =
  | { type: 'header'; key: string; category: RecipeCategory; count: number }
  | { type: 'recipe'; key: string; recipe: Recipe };

/**
 * The list as it is rendered: recipes, with a heading above each group when
 * the cookbook is being read by category.
 *
 * Headings only when they say something. Under a category filter every recipe
 * is in the same group, so a heading there is a label on a list of one thing.
 */
export function toRows(recipes: Recipe[], filters: CookbookFilters): CookbookRow[] {
  const grouped = filters.sort === 'category' && filters.category === ALL_CATEGORIES;
  if (!grouped) return recipes.map((recipe) => ({ type: 'recipe', key: recipe.id, recipe }));

  const sizes = new Map<RecipeCategory, number>();
  for (const recipe of recipes) {
    const category = recipeCategory(recipe);
    sizes.set(category, (sizes.get(category) ?? 0) + 1);
  }

  const rows: CookbookRow[] = [];
  let current: RecipeCategory | null = null;
  for (const recipe of recipes) {
    const category = recipeCategory(recipe);
    if (category !== current) {
      current = category;
      rows.push({ type: 'header', key: `header:${category}`, category, count: sizes.get(category) ?? 0 });
    }
    rows.push({ type: 'recipe', key: recipe.id, recipe });
  }
  return rows;
}
