import { describe, expect, test } from 'bun:test'
import { normalizeQuantity, normalizeIngredients } from '../utils/quantity'

describe('normalizeQuantity', () => {
  test('canonicalizes simple amounts with units', () => {
    expect(normalizeQuantity('1 cup')).toBe('1 cup')
    expect(normalizeQuantity('2 cups')).toBe('2 cup')
    expect(normalizeQuantity('200g')).toBe('200 g')
    expect(normalizeQuantity('200 grams')).toBe('200 g')
    expect(normalizeQuantity('1.5 Tablespoons')).toBe('1.5 tbsp')
    expect(normalizeQuantity('3 tsp.')).toBe('3 tsp')
    expect(normalizeQuantity('2 lbs')).toBe('2 lb')
    expect(normalizeQuantity('1 c')).toBe('1 cup')
  })

  test('converts fractions to decimals', () => {
    expect(normalizeQuantity('1/2 cup')).toBe('0.5 cup')
    expect(normalizeQuantity('1 1/2 cups')).toBe('1.5 cup')
    expect(normalizeQuantity('½ tsp')).toBe('0.5 tsp')
    expect(normalizeQuantity('1½ cups')).toBe('1.5 cup')
    expect(normalizeQuantity('1 ½ cups')).toBe('1.5 cup')
    expect(normalizeQuantity('¾')).toBe('0.75')
    expect(normalizeQuantity('1/3 cup')).toBe('0.33 cup')
  })

  test('bare counts stay numeric', () => {
    expect(normalizeQuantity('2')).toBe('2')
    expect(normalizeQuantity(' 12 ')).toBe('12')
  })

  test('leaves freeform strings untouched', () => {
    expect(normalizeQuantity('to taste')).toBe('to taste')
    expect(normalizeQuantity('2-3')).toBe('2-3')
    expect(normalizeQuantity('2 bunches')).toBe('2 bunches')
    expect(normalizeQuantity('1 large')).toBe('1 large')
    expect(normalizeQuantity('1 cup or 200g')).toBe('1 cup or 200g')
  })

  test('handles non-string and empty inputs', () => {
    expect(normalizeQuantity(undefined)).toBe('')
    expect(normalizeQuantity(null)).toBe('')
    expect(normalizeQuantity('   ')).toBe('')
  })
})

describe('normalizeIngredients', () => {
  test('maps quantities and tolerates missing arrays', () => {
    expect(normalizeIngredients(null)).toEqual([])
    expect(
      normalizeIngredients([
        { name: 'flour', quantity: '1 1/2 cups' },
        { name: 'salt', quantity: undefined },
      ])
    ).toEqual([
      { name: 'flour', quantity: '1.5 cup' },
      { name: 'salt', quantity: '' },
    ])
  })
})
