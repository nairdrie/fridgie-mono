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
    // Ranges are PRESERVED — collapsing to the low end made you under-buy.
    expect(normalizeQuantity('2-3')).toBe('2-3')
    expect(normalizeQuantity('2 - 3 cups')).toBe('2-3 cup')
    expect(normalizeQuantity('5 to 10 cloves')).toBe('5-10 clove')
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
    // "large" is a size, not a unit — it belongs on the item name.
    expect(normalizeQuantity('1 large')).toBe('1')
    expect(normalizeQuantity('1 cup or 200g')).toBe('1 cup or 200g')
  })

  test('canonicalizes the value of an unknown unit but keeps the token', () => {
    expect(normalizeQuantity('2 bunches')).toBe('2 bunch')
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
    // Cooks read fractions, not decimals.
    expect(aggregateQuantities(['1 cup', '2 tbsp'])).toBe('1⅛ cups')
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
    expect(aggregateQuantities(['1 clove', '2 cloves'])).toBe('3 cloves')
    expect(aggregateQuantities(['1 slice', '2 slices'])).toBe('3 slices')
    expect(aggregateQuantities(['1 bunch', '2 bunches'])).toBe('3 bunches')
  })

  test('carries unparseable values through instead of dropping them', () => {
    // Dropping these understated the total and hid the quantity chip entirely.
    expect(aggregateQuantities(['1 cup', 'to taste'])).toBe('1 cup + to taste')
    expect(aggregateQuantities(['to taste'])).toBe('to taste')
    expect(aggregateQuantities([undefined, '2'])).toBe('2')
  })

  test('keeps different dimensions separate', () => {
    // No ingredient name, so no density is available to bridge them.
    expect(aggregateQuantities(['200 g', '2 tsp'])).toBe('200 g + 2 tsp')
  })
})

describe('ranges', () => {
  test('both ends survive parsing', () => {
    expect(parseQuantity('5-10 cloves')).toMatchObject({ min: 5, max: 10, unit: 'clove' })
    expect(parseQuantity('5 to 10 cloves')).toMatchObject({ min: 5, max: 10 })
    expect(parseQuantity('2 cloves')).toMatchObject({ min: 2, max: 2 })
  })

  test('add end to end', () => {
    // The reported case: 2 cloves plus "5-10 minced" should be 7-12, not
    // "2 + 5-10, minced". Truncating to the low end made you under-buy.
    expect(aggregateQuantities(['2', '5-10 minced'], 'garlic')).toBe('7–12')
    expect(aggregateQuantities(['2 cloves', '5-10 cloves, minced'], 'garlic')).toBe('7–12 cloves')
    expect(aggregateQuantities(['2-3 cloves', '5-10 cloves'], 'garlic')).toBe('7–13 cloves')
  })
})

describe('preparation words are not units', () => {
  test('are stripped from the amount and kept as notes', () => {
    expect(parseQuantity('5-10 cloves, minced')).toMatchObject({ unit: 'clove', prep: ['minced'] })
    expect(parseQuantity('1 ½ cups packed')).toMatchObject({ unit: 'cup', prep: ['packed'] })
    expect(parseQuantity('1 large')).toMatchObject({ unit: null, prep: ['large'] })
  })

  test('a real unit wins over a word that is in both vocabularies', () => {
    // "slice" is both a preparation and a count unit; treating the singular as
    // prep and the plural as a unit meant they never combined.
    expect(aggregateQuantities(['1 slice', '2 slices'])).toBe('3 slices')
  })
})

describe('density unlocks mass ↔ volume', () => {
  test('combines cups and grams for a known ingredient', () => {
    expect(aggregateQuantities(['1 cup', '10 g', '2 tsp'], 'all-purpose flour')).toBe('1⅛ cups')
    expect(aggregateQuantities(['1 cup', '100 g'], 'granulated sugar')).toBe('1½ cups')
    expect(aggregateQuantities(['1/2 cup', '50 g'], 'butter')).toBe('¾ cup')
  })

  test('leaves them separate when the ingredient is unknown', () => {
    expect(aggregateQuantities(['1 cup', '10 g'], 'dragonfruit puree')).toBe('1 cup + 10 g')
  })

  test('picks the more specific density', () => {
    // "brown sugar" must not match the generic "sugar" entry.
    const brown = aggregateQuantities(['1 cup', '220 g'], 'brown sugar')
    const white = aggregateQuantities(['1 cup', '220 g'], 'granulated sugar')
    expect(brown).toBe('2 cups')
    expect(brown).not.toBe(white)
  })
})

describe('display reads like a recipe', () => {
  test('snaps to fractions rather than decimals', () => {
    expect(aggregateQuantities(['1 cup', '2 tbsp'])).toBe('1⅛ cups')
    expect(aggregateQuantities(['1/2 cup'])).toBe('½ cup')
  })

  test('absorbs negligible additions', () => {
    // 2 tsp on top of a cup is not something you shop differently for.
    expect(aggregateQuantities(['1 cup', '2 tsp'], 'flour')).toBe('1 cup')
  })

  test('promotes units at sensible magnitudes', () => {
    expect(aggregateQuantities(['600 g', '600 g'], 'flour')).toBe('1.2 kg')
  })

  test('pluralizes correctly, including abbreviations', () => {
    expect(aggregateQuantities(['200 g', '2 tsp'])).toBe('200 g + 2 tsp')  // not "tsps"
    expect(aggregateQuantities(['1 bunch', '2 bunches'])).toBe('3 bunches') // not "bunchs"
    expect(aggregateQuantities(['1/2 cup', '50 g'], 'butter')).toBe('¾ cup') // not "¾ cups"
  })

  test('refuses to guess at compound expressions', () => {
    expect(normalizeQuantity('1 cup or 200g')).toBe('1 cup or 200g')
    expect(normalizeQuantity('2 cups (500 ml)')).toBe('2 cups (500 ml)')
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
