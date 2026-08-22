import { describe, expect, test } from 'bun:test'
import {
  FALLBACK_RECIPE_CATEGORY,
  RECIPE_CATEGORIES,
  categoryOrder,
  guessRecipeCategory,
  normalizeRecipeCategory,
} from '@fridgie/shared/recipeCategory'

describe('normalizeRecipeCategory', () => {
  test('accepts every category it emits', () => {
    for (const category of RECIPE_CATEGORIES) {
      expect(normalizeRecipeCategory(category)).toBe(category)
    }
  })

  test('is indifferent to case, spacing and how "&" is written', () => {
    expect(normalizeRecipeCategory('soups & stews')).toBe('Soups & Stews')
    expect(normalizeRecipeCategory('Soups and Stews')).toBe('Soups & Stews')
    expect(normalizeRecipeCategory('  BAKED   GOODS ')).toBe('Baked Goods')
  })

  // The model is enum-constrained, but a recipe imported from a site's own
  // keywords, or saved before this vocabulary existed, says it differently.
  test('maps the words other people use', () => {
    expect(normalizeRecipeCategory('Dessert')).toBe('Desserts')
    expect(normalizeRecipeCategory('main course')).toBe('Mains')
    expect(normalizeRecipeCategory('Entree')).toBe('Mains')
    expect(normalizeRecipeCategory('appetizer')).toBe('Snacks & Appetizers')
    expect(normalizeRecipeCategory('baking')).toBe('Baked Goods')
    expect(normalizeRecipeCategory('brunch')).toBe('Breakfast')
  })

  test('rejects anything else, rather than inventing a shelf', () => {
    expect(normalizeRecipeCategory('Weeknight')).toBeNull()
    expect(normalizeRecipeCategory('')).toBeNull()
    expect(normalizeRecipeCategory(undefined)).toBeNull()
    expect(normalizeRecipeCategory(null)).toBeNull()
    expect(normalizeRecipeCategory(3)).toBeNull()
    expect(normalizeRecipeCategory(['Desserts'])).toBeNull()
  })
})

describe('guessRecipeCategory', () => {
  test('reads the obvious cases off the title', () => {
    expect(guessRecipeCategory({ name: 'Banana Bread' })).toBe('Baked Goods')
    expect(guessRecipeCategory({ name: 'Chocolate Chip Cookies' })).toBe('Desserts')
    expect(guessRecipeCategory({ name: 'Tomato Basil Soup' })).toBe('Soups & Stews')
    expect(guessRecipeCategory({ name: 'Spaghetti Bolognese' })).toBe('Mains')
    expect(guessRecipeCategory({ name: 'Overnight Oats' })).toBe('Breakfast')
    expect(guessRecipeCategory({ name: 'Classic Margarita' })).toBe('Drinks')
  })

  // The whole design of the rule order: the same protein appears in four
  // different courses, so the course word has to win over the ingredient.
  test('lets the course word beat the ingredient', () => {
    expect(guessRecipeCategory({ name: 'Chicken Caesar Salad' })).toBe('Salads')
    expect(guessRecipeCategory({ name: 'Chicken Noodle Soup' })).toBe('Soups & Stews')
    expect(guessRecipeCategory({ name: 'Buffalo Chicken Wings' })).toBe('Snacks & Appetizers')
    expect(guessRecipeCategory({ name: 'Chicken Tikka Masala' })).toBe('Mains')
  })

  test('files savoury pies as dinner and sweet ones as pudding', () => {
    expect(guessRecipeCategory({ name: "Shepherd's Pie" })).toBe('Mains')
    expect(guessRecipeCategory({ name: 'Chicken Pot Pie' })).toBe('Mains')
    expect(guessRecipeCategory({ name: 'Apple Pie' })).toBe('Desserts')
    expect(guessRecipeCategory({ name: 'Bread Pudding' })).toBe('Desserts')
  })

  test('matches whole words only', () => {
    // "pie" in pierogi, "bun" in bundt — a substring match files both wrongly.
    expect(guessRecipeCategory({ name: 'Potato Pierogi' })).toBeNull()
    expect(guessRecipeCategory({ name: 'Lemon Bundt' })).toBeNull()
  })

  test('says nothing rather than guessing at a proper name', () => {
    expect(guessRecipeCategory({ name: 'Bibimbap' })).toBeNull()
    expect(guessRecipeCategory({ name: "Nonna's Tuesday Special" })).toBeNull()
    expect(guessRecipeCategory({})).toBeNull()
  })

  test('falls back to a description that declares the course', () => {
    expect(guessRecipeCategory({
      name: 'Eton Mess',
      description: 'A summer dessert of berries, cream and broken meringue.',
    })).toBe('Desserts')
  })

  // Descriptions name other courses constantly. Reading a title's worth of
  // meaning into "serve with a salad" is how a curry ends up under Salads.
  test('ignores the other courses a description mentions in passing', () => {
    expect(guessRecipeCategory({
      name: 'Bibimbap',
      description: 'A Korean rice bowl, good with a green salad and a cold beer.',
    })).toBeNull()
  })
})

describe('categoryOrder', () => {
  test('runs in menu order, with the fallback last', () => {
    expect(categoryOrder('Breakfast')).toBeLessThan(categoryOrder('Desserts'))
    expect(categoryOrder('Desserts')).toBeLessThan(categoryOrder(FALLBACK_RECIPE_CATEGORY))
  })

  test('puts anything it doesn\'t know past everything it does', () => {
    expect(categoryOrder('Elevenses')).toBeGreaterThanOrEqual(RECIPE_CATEGORIES.length)
  })
})
