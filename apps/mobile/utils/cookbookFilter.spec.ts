import { describe, expect, test } from 'bun:test'
import {
  ALL_CATEGORIES,
  categoryChips,
  filterCookbook,
  matchesSearch,
  recipeCategory,
  sortRecipes,
  toRows,
  type CookbookSort,
} from './cookbookFilter'

/** A recipe with only the fields the cookbook filters actually read. */
const recipe = (name: string, extra: Record<string, any> = {}): any => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  description: '',
  ingredients: [],
  instructions: [],
  ...extra,
})

const shelf = [
  recipe('Focaccia', { category: 'Baked Goods', addedAt: '2026-01-03T00:00:00.000Z' }),
  recipe('Beef Chili', { category: 'Soups & Stews', addedAt: '2026-01-05T00:00:00.000Z' }),
  recipe('Apple Crumble', { category: 'Desserts', addedAt: '2026-01-01T00:00:00.000Z' }),
  recipe('Carbonara', { category: 'Mains', addedAt: '2026-01-04T00:00:00.000Z', tags: ['italian'] }),
]

const names = (recipes: any[]) => recipes.map((r) => r.name)
const filtered = (recipes: any[], searchTerm = '', category: any = ALL_CATEGORIES, sort: CookbookSort = 'recent') =>
  names(filterCookbook(recipes, { searchTerm, category, sort }))

describe('recipeCategory', () => {
  test('reads an unfiled recipe as Other rather than as nothing', () => {
    expect(recipeCategory(recipe('Mystery Casserole'))).toBe('Other')
    expect(recipeCategory(recipe('Mystery', { category: 'not a shelf' }))).toBe('Other')
  })
})

describe('matchesSearch', () => {
  test('searches the name, the description, the tags and the category', () => {
    const r = recipe('Carbonara', { description: 'A Roman classic', tags: ['italian'], category: 'Mains' })
    expect(matchesSearch(r, 'carb')).toBe(true)
    expect(matchesSearch(r, 'roman')).toBe(true)
    expect(matchesSearch(r, 'italian')).toBe(true)
    expect(matchesSearch(r, 'mains')).toBe(true)
    expect(matchesSearch(r, 'pudding')).toBe(false)
  })

  test('an empty search matches everything', () => {
    expect(matchesSearch(recipe('Anything'), '   ')).toBe(true)
  })
})

describe('categoryChips', () => {
  test('offers All first, then the shelves actually in use, in menu order', () => {
    expect(categoryChips(shelf, ALL_CATEGORIES).map((c) => c.label))
      .toEqual(['All', 'Mains', 'Soups & Stews', 'Baked Goods', 'Desserts'])
  })

  test('counts what is on each shelf', () => {
    const chips = categoryChips([...shelf, recipe('Ciabatta', { category: 'Baked Goods' })], ALL_CATEGORIES)
    expect(chips.find((c) => c.label === 'All')!.count).toBe(5)
    expect(chips.find((c) => c.label === 'Baked Goods')!.count).toBe(2)
  })

  // Otherwise typing a search that excludes the selected shelf takes its chip
  // away, and the list looks empty with nothing on screen explaining why.
  test('keeps the selected chip even when the search left nothing on it', () => {
    const chips = categoryChips([recipe('Carbonara', { category: 'Mains' })], 'Desserts')
    expect(chips.find((c) => c.label === 'Desserts')).toEqual({ key: 'Desserts', label: 'Desserts', count: 0 })
  })

  test('draws no bar at all for a cookbook that is all one thing', () => {
    expect(categoryChips([recipe('Carbonara', { category: 'Mains' })], ALL_CATEGORIES)).toEqual([])
    expect(categoryChips([], ALL_CATEGORIES)).toEqual([])
  })
})

describe('sortRecipes', () => {
  test('newest on the shelf first', () => {
    expect(names(sortRecipes(shelf, 'recent'))).toEqual(['Beef Chili', 'Carbonara', 'Focaccia', 'Apple Crumble'])
  })

  test('keeps the order it was given for recipes with no addedAt yet', () => {
    const unstamped = [recipe('Zabaglione'), recipe('Aioli')]
    expect(names(sortRecipes(unstamped, 'recent'))).toEqual(['Zabaglione', 'Aioli'])
  })

  test('A–Z ignores case', () => {
    expect(names(sortRecipes([recipe('banana bread'), recipe('Apple Pie')], 'name')))
      .toEqual(['Apple Pie', 'banana bread'])
  })

  test('by category runs in menu order, alphabetical within a shelf', () => {
    const withTwoMains = [...shelf, recipe('Bolognese', { category: 'Mains' })]
    expect(names(sortRecipes(withTwoMains, 'category')))
      .toEqual(['Bolognese', 'Carbonara', 'Beef Chili', 'Focaccia', 'Apple Crumble'])
  })

  test('never reorders the array it was handed', () => {
    const original = [...shelf]
    sortRecipes(shelf, 'name')
    expect(shelf).toEqual(original)
  })
})

describe('filterCookbook', () => {
  test('narrows to one shelf', () => {
    expect(filtered(shelf, '', 'Desserts')).toEqual(['Apple Crumble'])
  })

  test('applies the search and the shelf together', () => {
    expect(filtered(shelf, 'a', 'Mains')).toEqual(['Carbonara'])
    expect(filtered(shelf, 'chili', 'Desserts')).toEqual([])
  })
})

describe('toRows', () => {
  test('heads each group when the whole cookbook is read by category', () => {
    const filters = { searchTerm: '', category: ALL_CATEGORIES, sort: 'category' as const }
    const rows = toRows(filterCookbook(shelf, filters), filters)
    expect(rows.map((row) => (row.type === 'header' ? `# ${row.category}` : row.recipe.name)))
      .toEqual(['# Mains', 'Carbonara', '# Soups & Stews', 'Beef Chili', '# Baked Goods', 'Focaccia', '# Desserts', 'Apple Crumble'])
  })

  test('counts the group on its heading', () => {
    const filters = { searchTerm: '', category: ALL_CATEGORIES, sort: 'category' as const }
    const withTwoMains = [...shelf, recipe('Bolognese', { category: 'Mains' })]
    const rows = toRows(filterCookbook(withTwoMains, filters), filters)
    const header = rows.find((row) => row.type === 'header' && row.category === 'Mains')
    expect(header).toMatchObject({ count: 2 })
  })

  // One shelf, one heading, saying what the chip above it already says.
  test('drops the headings once a single category is selected', () => {
    const filters = { searchTerm: '', category: 'Mains' as const, sort: 'category' as const }
    const rows = toRows(filterCookbook(shelf, filters), filters)
    expect(rows.every((row) => row.type === 'recipe')).toBe(true)
  })

  test('leaves the other sorts ungrouped', () => {
    const filters = { searchTerm: '', category: ALL_CATEGORIES, sort: 'recent' as const }
    const rows = toRows(filterCookbook(shelf, filters), filters)
    expect(rows.every((row) => row.type === 'recipe')).toBe(true)
  })
})
