import { describe, expect, test } from 'bun:test'
import {
  boundedEditDistance,
  buildCategoryIndex,
  cacheKeysFor,
  canonicalKey,
  canonicalTokens,
  findCategory,
  normalizeItemText,
} from '../utils/itemMatch'

describe('canonicalTokens', () => {
  test('strips quantity, units and packaging', () => {
    expect(canonicalTokens('2 lbs chicken breast')).toEqual(['chicken', 'breast'])
    expect(canonicalTokens('1/2 cup of milk')).toEqual(['milk'])
    expect(canonicalTokens('3 cloves garlic')).toEqual(['garlic'])
    expect(canonicalTokens('1 (14 oz) can black beans')).toEqual(['black', 'bean'])
  })

  test('strips prep and grade words but folds plurals', () => {
    expect(canonicalTokens('Boneless Skinless Chicken Breasts')).toEqual(['chicken', 'breast'])
    expect(canonicalTokens('finely chopped onions')).toEqual(['onion'])
    expect(canonicalTokens('organic large eggs')).toEqual(['egg'])
  })

  test('keeps the words that decide the aisle', () => {
    // Frozen Foods vs Produce, Pantry vs Produce — stripping these would answer
    // confidently and wrongly.
    expect(canonicalTokens('frozen peas')).toEqual(['frozen', 'pea'])
    expect(canonicalTokens('dried basil')).toEqual(['dried', 'basil'])
    expect(canonicalTokens('2 lbs ground beef')).toEqual(['ground', 'beef'])
    expect(canonicalTokens('canned tomatoes')).toEqual(['canned', 'tomato'])
  })

  test('falls back to the words as written when everything is a modifier', () => {
    expect(canonicalTokens('extra large')).toEqual(['extra', 'large'])
    expect(canonicalTokens('  ')).toEqual([])
  })
})

describe('boundedEditDistance', () => {
  test('measures within the budget and gives up beyond it', () => {
    expect(boundedEditDistance('banana', 'banana', 2)).toBe(0)
    expect(boundedEditDistance('bananna', 'banana', 2)).toBe(1)
    expect(boundedEditDistance('cat', 'elephant', 2)).toBeGreaterThan(2)
  })
})

describe('findCategory', () => {
  const index = buildCategoryIndex({
    // A legacy entry, written under the whitespace-stripped key.
    chickenbreast: 'Meat & Poultry',
    'ground-beef': 'Meat & Poultry',
    'frozen-pea': 'Frozen Foods',
    banana: 'Produce',
    beef: 'Meat & Poultry',
    'sourdough-bread': 'Bakery',
  })

  test('hits the literal wording first', () => {
    expect(findCategory('Chicken Breast', index)).toEqual({
      section: 'Meat & Poultry',
      source: 'exact',
    })
  })

  test('hits on a rewording of a cached item', () => {
    expect(findCategory('2 lbs ground beef', index)?.section).toBe('Meat & Poultry')
    expect(findCategory('1 bag of frozen peas', index)?.section).toBe('Frozen Foods')
  })

  test('hits regardless of word order', () => {
    expect(findCategory('bread, sourdough', index)).toEqual({
      section: 'Bakery',
      source: 'reordered',
    })
  })

  test('forgives a typo in a long enough word', () => {
    expect(findCategory('bananna', index)).toEqual({ section: 'Produce', source: 'fuzzy' })
  })

  test('never guesses from a short near-miss', () => {
    // "beer" is one edit from the cached "beef" and a different aisle entirely.
    expect(findCategory('beer', index)).toBeNull()
  })

  test('never answers from a partial overlap', () => {
    // Coconut milk is not milk, and chicken broth is not chicken breast.
    expect(findCategory('coconut milk', index)).toBeNull()
    expect(findCategory('chicken broth', index)).toBeNull()
  })

  test('misses on genuinely new wording', () => {
    expect(findCategory('pomegranate molasses', index)).toBeNull()
  })
})

describe('cacheKeysFor', () => {
  test('writes back both the literal and the canonical key', () => {
    expect(cacheKeysFor('2 lbs Chicken Breasts').sort()).toEqual(
      ['2lbschickenbreasts', 'chicken-breast'].sort(),
    )
  })

  test('collapses to one key when the two agree', () => {
    expect(cacheKeysFor('milk')).toEqual(['milk'])
  })

  test('drops keys RTDB would reject', () => {
    expect(cacheKeysFor('')).toEqual([])
    // The canonical form survives; the literal one keeps the illegal slash.
    expect(cacheKeysFor('half/half')).toEqual(['half-half'])
  })
})

describe('normalizeItemText', () => {
  test('is unchanged, so the existing cache still resolves', () => {
    expect(normalizeItemText('  Chicken   Breast ')).toBe('chickenbreast')
    expect(canonicalKey('Chicken Breast')).toBe('chicken-breast')
  })
})
