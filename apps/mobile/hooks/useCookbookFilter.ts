// The state behind the cookbook's filter bar, in one place so that every screen
// showing a cookbook starts from the same defaults and answers a search the
// same way.

import { Recipe } from '@/types/types';
import {
  ALL_CATEGORIES,
  categoryChips,
  filterCookbook,
  matchesSearch,
  toRows,
  type CategoryChip,
  type CategoryFilter,
  type CookbookRow,
  type CookbookSort,
} from '@/utils/cookbookFilter';
import { useCallback, useMemo, useState } from 'react';

export interface CookbookFilter {
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  category: CategoryFilter;
  setCategory: (category: CategoryFilter) => void;
  sort: CookbookSort;
  setSort: (sort: CookbookSort) => void;
  /** Chips to draw, counted against what the search has already left. */
  chips: CategoryChip[];
  /** Filtered and sorted, for a plain list. */
  recipes: Recipe[];
  /** The same, with category headings where they earn their place. */
  rows: CookbookRow[];
  /** Whether anything is narrowing the list — the empty state reads differently if so. */
  isFiltered: boolean;
  /** Back to an unfiltered shelf. For sheets that are reused rather than remounted. */
  reset: () => void;
}

export function useCookbookFilter(
  recipes: Recipe[],
  initialSort: CookbookSort = 'recent',
): CookbookFilter {
  const [searchTerm, setSearchTerm] = useState('');
  const [category, setCategory] = useState<CategoryFilter>(ALL_CATEGORIES);
  const [sort, setSort] = useState<CookbookSort>(initialSort);

  // Chips count what SEARCH leaves, not what the category filter leaves —
  // counted after the category too, every chip but the selected one would read
  // zero.
  const searched = useMemo(
    () => recipes.filter((recipe) => matchesSearch(recipe, searchTerm)),
    [recipes, searchTerm],
  );
  const chips = useMemo(() => categoryChips(searched, category), [searched, category]);

  const filters = useMemo(() => ({ searchTerm, category, sort }), [searchTerm, category, sort]);
  const visible = useMemo(() => filterCookbook(recipes, filters), [recipes, filters]);
  const rows = useMemo(() => toRows(visible, filters), [visible, filters]);

  const reset = useCallback(() => {
    setSearchTerm('');
    setCategory(ALL_CATEGORIES);
  }, []);

  return {
    searchTerm,
    setSearchTerm,
    category,
    setCategory,
    sort,
    setSort,
    chips,
    recipes: visible,
    rows,
    isFiltered: searchTerm.trim() !== '' || category !== ALL_CATEGORIES,
    reset,
  };
}
