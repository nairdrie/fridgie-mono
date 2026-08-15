import { describe, expect, test } from 'bun:test'
import {
  aggregateQuantities,
  formatQuantityDisplay,
  normalizeIngredients,
  normalizeQuantity,
  parseQuantity,
} from '../utils/quantity'

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

  test('accepts the unit spellings the client accepts', () => {
    // These used to fall through the server's alias table unchanged, so a
    // non-canonical string reached the database.
    expect(normalizeQuantity('500 gr')).toBe('500 g')
    expect(normalizeQuantity('2 kgs')).toBe('2 kg')
    expect(normalizeQuantity('3 kilos')).toBe('3 kg')
    expect(normalizeQuantity('250 mls')).toBe('250 ml')
  })

  test('converts fractions to decimals', () => {
    expect(normalizeQuantity('1/2 cup')).toBe('0.5 cup')
    expect(normalizeQuantity('1 1/2 cups')).toBe('1.5 cup')
    expect(normalizeQuantity('½ tsp')).toBe('0.5 tsp')
    expect(normalizeQuantity('1½ cups')).toBe('1.5 cup')
    expect(normalizeQuantity('1 ½ cups')).toBe('1.5 cup')
    expect(normalizeQuantity('¾')).toBe('0.75')
    expect(normalizeQuantity('1/3 cup')).toBe('0.33 cup')
    expect(normalizeQuantity('.5 cup')).toBe('0.5 cup')
  })

  test('normalizes the shapes LLM output actually produces', () => {
    // Ranges collapse to the lower bound (the importer prompt's own rule),
    // compound units become a single canonical token, decimal commas resolve.
    expect(normalizeQuantity('2-3')).toBe('2')
    expect(normalizeQuantity('2 - 3 cups')).toBe('2 cup')
    expect(normalizeQuantity('8 fl oz')).toBe('8 fl oz')
    expect(normalizeQuantity('8 fl. oz.')).toBe('8 fl oz')
    expect(normalizeQuantity('1,5 kg')).toBe('1.5 kg')
  })

  test('bare counts stay numeric', () => {
    expect(normalizeQuantity('2')).toBe('2')
    expect(normalizeQuantity(' 12 ')).toBe('12')
  })

  test('leaves genuinely freeform strings untouched', () => {
    expect(normalizeQuantity('to taste')).toBe('to taste')
    expect(normalizeQuantity('1 large')).toBe('1 large')
    expect(normalizeQuantity('1 cup or 200g')).toBe('1 cup or 200g')
  })

  test('canonicalizes the value of an unknown unit but keeps the token', () => {
    expect(normalizeQuantity('2 bunches')).toBe('2 bunches')
    expect(normalizeQuantity('1/2 bunch')).toBe('0.5 bunch')
  })

  test('handles non-string and empty inputs', () => {
    expect(normalizeQuantity(undefined)).toBe('')
    expect(normalizeQuantity(null)).toBe('')
    expect(normalizeQuantity('   ')).toBe('')
  })
})

/**
 * The contract that actually matters across the two apps: anything the server
 * stores must be readable by the client's parser. These previously disagreed —
 * the server emitted "2 cup" while the client only produced "2 cups", and the
 * client's parser rejected the trailing period the server allowed.
 */
describe('server output ↔ client parser round-trip', () => {
  const SAMPLES = [
    '1 cup', '2 cups', '200g', '200 grams', '1.5 Tablespoons', '3 tsp.',
    '2 lbs', '1 c', '1/2 cup', '1 1/2 cups', '½ tsp', '1½ cups', '¾',
    '.5 cup', '500 gr', '2 kgs', '250 mls', '2-3', '2 - 3 cups',
    '8 fl oz', '1,5 kg', '2', '2 bunches',
  ]

  test('every normalized value parses back', () => {
    for (const raw of SAMPLES) {
      const normalized = normalizeQuantity(raw)
      expect(parseQuantity(normalized)).not.toBeNull()
    }
  })

  test('normalization is a fixed point', () => {
    for (const raw of SAMPLES) {
      const once = normalizeQuantity(raw)
      expect(normalizeQuantity(once)).toBe(once)
    }
  })
})

describe('formatQuantityDisplay', () => {
  test('pluralizes for display only — storage stays singular', () => {
    expect(formatQuantityDisplay(2, 'cup')).toBe('2 cups')
    expect(formatQuantityDisplay(1, 'cup')).toBe('1 cup')
    expect(normalizeQuantity('2 cups')).toBe('2 cup')
  })
})

describe('aggregateQuantities', () => {
  test('combines same-dimension quantities', () => {
    expect(aggregateQuantities(['1 cup', '2 tbsp'])).toBe('1.13 cups')
    expect(aggregateQuantities(['200 g', '1 kg'])).toBe('1.2 kg')
  })

  test('is order-independent', () => {
    // The output unit used to be whichever quantity happened to come first,
    // and the server controls that order by appending meal ingredients.
    expect(aggregateQuantities(['1 cup', '2 tbsp']))
      .toBe(aggregateQuantities(['2 tbsp', '1 cup']))
    expect(aggregateQuantities(['200 g', '1 kg']))
      .toBe(aggregateQuantities(['1 kg', '200 g']))
  })

  test('merges singular and plural spellings of unknown units', () => {
    expect(aggregateQuantities(['1 clove', '2 cloves'])).toBe('3 clove')
    expect(aggregateQuantities(['1 slice', '2 slices'])).toBe('3 slice')
    expect(aggregateQuantities(['1 bunch', '2 bunches'])).toBe('3 bunch')
  })

  test('carries unparseable values through instead of dropping them', () => {
    // Dropping these understated the total and hid the quantity chip entirely.
    expect(aggregateQuantities(['1 cup', 'to taste'])).toBe('1 cup + to taste')
    expect(aggregateQuantities(['to taste'])).toBe('to taste')
    expect(aggregateQuantities([undefined, '2'])).toBe('2')
  })

  test('keeps different dimensions separate', () => {
    expect(aggregateQuantities(['200 g', '2 tsp'])).toBe('200 g + 2 tsp')
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
