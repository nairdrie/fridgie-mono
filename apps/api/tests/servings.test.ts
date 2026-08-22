import { describe, expect, test } from 'bun:test'
import {
  describeScale,
  normalizeRecipeServings,
  parseServings,
  scaleIngredients,
  scaleQuantity,
  servingsScale,
} from '../utils/servings'

describe('parseServings', () => {
  test('reads the shapes recipe sites actually publish', () => {
    expect(parseServings('4')).toBe(4)
    expect(parseServings('4 servings')).toBe(4)
    expect(parseServings('Serves 4')).toBe(4)
    expect(parseServings('serves 6 people')).toBe(6)
    expect(parseServings('Yields 8 portions')).toBe(8)
    expect(parseServings('  2 Servings  ')).toBe(2)
    expect(parseServings(4)).toBe(4)
  })

  test('a range takes its low end — the amounts were written for that number', () => {
    expect(parseServings('serves 4-6')).toBe(4)
    expect(parseServings('4 to 6 servings')).toBe(4)
    expect(parseServings('6–8 people')).toBe(6)
  })

  test('a yield that counts OBJECTS is not a serving count', () => {
    // The failure this prevents: scaling a 2-person household against "12
    // cookies" divides every quantity by six.
    expect(parseServings('Makes 12 cookies')).toBeNull()
    expect(parseServings('24 muffins')).toBeNull()
    expect(parseServings('1 loaf')).toBeNull()
    expect(parseServings('2 dozen')).toBeNull()
    expect(parseServings('1 9-inch pie')).toBeNull()
  })

  test('rejects junk and implausible counts rather than guessing', () => {
    expect(parseServings(null)).toBeNull()
    expect(parseServings(undefined)).toBeNull()
    expect(parseServings('')).toBeNull()
    expect(parseServings('some')).toBeNull()
    expect(parseServings('0')).toBeNull()
    expect(parseServings('200 servings')).toBeNull()
    expect(parseServings(NaN)).toBeNull()
  })
})

describe('servingsScale', () => {
  test('a missing number on either side means do not scale', () => {
    expect(servingsScale(undefined, 2)).toBe(1)
    expect(servingsScale(4, undefined)).toBe(1)
    expect(servingsScale(null, null)).toBe(1)
    expect(servingsScale(0, 4)).toBe(1)
  })

  test('scales household against yield', () => {
    expect(servingsScale(4, 2)).toBe(0.5)
    expect(servingsScale(2, 4)).toBe(2)
    expect(servingsScale(4, 4)).toBe(1)
    expect(servingsScale(4, 6)).toBe(1.5)
  })

  test('clamps, because a factor that extreme is a misparsed yield', () => {
    expect(servingsScale(1, 20)).toBe(8)
    expect(servingsScale(50, 1)).toBe(0.25)
  })
})

describe('scaleQuantity', () => {
  test('a factor of 1 is a no-op', () => {
    expect(scaleQuantity('200 g', 1)).toBe('200 g')
    expect(scaleQuantity('to taste', 1)).toBe('to taste')
  })

  test('scales mass and volume', () => {
    expect(scaleQuantity('200 g', 2)).toBe('400 g')
    expect(scaleQuantity('1 cup', 0.5)).toBe('0.5 cup')
    expect(scaleQuantity('1.5 tbsp', 2)).toBe('3 tbsp')
  })

  test('preserves ranges, scaling both ends', () => {
    expect(scaleQuantity('2-3 clove', 2)).toBe('4-6 clove')
  })

  test('unparseable strings pass through untouched', () => {
    // "2 to taste" is the failure being prevented here.
    expect(scaleQuantity('to taste', 3)).toBe('to taste')
    expect(scaleQuantity('a splash', 2)).toBe('a splash')
    expect(scaleQuantity('', 2)).toBe('')
    expect(scaleQuantity('1 cup or 200g', 2)).toBe('1 cup or 200g')
  })

  test('counts snap to halves — a third of a lemon is not an instruction', () => {
    expect(scaleQuantity('1', 1.5)).toBe('1.5')
    expect(scaleQuantity('2', 0.5)).toBe('1')
    expect(scaleQuantity('1', 0.33)).toBe('0.5')
    // Never rounds a needed ingredient away to nothing.
    expect(scaleQuantity('1', 0.25)).toBe('0.5')
  })

  test('packaged units round up to a whole — you cannot buy half a tin', () => {
    expect(scaleQuantity('1 can', 1.5)).toBe('2 can')
    expect(scaleQuantity('2 jar', 0.5)).toBe('1 jar')
    expect(scaleQuantity('1 packet', 0.25)).toBe('1 packet')
  })

  test('non-strings are not quantities', () => {
    expect(scaleQuantity(undefined, 2)).toBe('')
    expect(scaleQuantity(null, 2)).toBe('')
    expect(scaleQuantity(7, 2)).toBe('')
  })
})

describe('scaleIngredients', () => {
  test('returns the input untouched at a factor of 1', () => {
    const ingredients = [{ name: 'flour', quantity: '200 g' }]
    expect(scaleIngredients(ingredients, 1)).toBe(ingredients)
  })

  test('scales every quantity and keeps every other field', () => {
    expect(
      scaleIngredients([{ name: 'flour', quantity: '200 g', note: 'sifted' }], 2),
    ).toEqual([{ name: 'flour', quantity: '400 g', note: 'sifted' }])
  })

  test('survives a missing or non-array ingredient list', () => {
    expect(scaleIngredients(undefined, 2)).toEqual([])
    expect(scaleIngredients(null, 2)).toEqual([])
  })
})

describe('normalizeRecipeServings', () => {
  test('keeps a valid count', () => {
    expect(normalizeRecipeServings({ servings: 6 })).toEqual({ servings: 6 })
  })

  test('REMOVES the key rather than defaulting it', () => {
    // The whole safety property: absent must stay distinguishable from a
    // stated 4, or an unknown yield silently halves a two-person shop.
    expect(normalizeRecipeServings({ servings: null, name: 'x' })).toEqual({ name: 'x' })
    expect('servings' in normalizeRecipeServings({ servings: null })).toBe(false)
    expect('servings' in normalizeRecipeServings({ servings: 0 })).toBe(false)
    expect('servings' in normalizeRecipeServings({ servings: 999 })).toBe(false)
    expect('servings' in normalizeRecipeServings({})).toBe(false)
  })
})

describe('describeScale', () => {
  test('says what happened, or says nothing', () => {
    expect(describeScale(4, 4)).toBe('Serves 4')
    expect(describeScale(4, 2)).toBe('Scaled for 2')
    expect(describeScale(undefined, 2)).toBeNull()
    expect(describeScale(4, undefined)).toBe('Serves 4')
  })
})
