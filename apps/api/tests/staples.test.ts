import { describe, expect, test } from 'bun:test'
import { STAPLE_THRESHOLD, detectStapleRejections, isStapleRow, stapleKey } from '@fridgie/shared/staples'

/** A recipe-generated row, which is the only kind that can be a rejection. */
const row = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  checked: false,
  isSection: false,
  mealId: 'meal-1',
  ...extra,
})

const MEALS = [{ id: 'meal-1' }, { id: 'meal-2' }]

describe('stapleKey', () => {
  test('folds the wordings of one ingredient onto one key', () => {
    expect(stapleKey('Olive Oil')).toBe(stapleKey('olive oil'))
    expect(stapleKey('2 tbsp olive oil')).toBe(stapleKey('olive oil'))
    expect(stapleKey('Olive Oils')).toBe(stapleKey('olive oil'))
    expect(stapleKey('Chicken Breasts')).toBe(stapleKey('chicken breast'))
  })

  test('matching is exact — a distinct wording is a distinct staple', () => {
    // Conservative on purpose, for the same reason findCategory is: partial
    // overlap would let "milk" hide "coconut milk".
    expect(stapleKey('coconut milk')).not.toBe(stapleKey('milk'))
    expect(stapleKey('sesame oil')).not.toBe(stapleKey('olive oil'))
  })

  test('refuses text that cannot be an RTDB key', () => {
    expect(stapleKey('')).toBe('')
    expect(stapleKey(null)).toBe('')
    expect(stapleKey(undefined)).toBe('')
    expect(stapleKey('   ')).toBe('')
    expect(stapleKey('a'.repeat(400))).toBe('')
  })

  test('never emits a path separator, whatever the input', () => {
    for (const text of ['salt/pepper', 'a.b', 'x#y', '$var', 'a[0]']) {
      const key = stapleKey(text)
      expect(key).not.toMatch(/[.#$[\]/]/)
    }
  })
})

describe('isStapleRow', () => {
  const staples = new Set([stapleKey('olive oil')])

  test('matches any wording of a staple', () => {
    expect(isStapleRow('Olive Oil', staples)).toBe(true)
    expect(isStapleRow('2 tbsp Olive Oil', staples)).toBe(true)
  })

  test('does not match a different ingredient', () => {
    expect(isStapleRow('sesame oil', staples)).toBe(false)
    expect(isStapleRow('', staples)).toBe(false)
    expect(isStapleRow('olive oil', new Set())).toBe(false)
  })
})

describe('detectStapleRejections', () => {
  test('a deleted, never-checked recipe row is a rejection', () => {
    const before = { items: [row('a', 'olive oil'), row('b', 'chicken')], meals: MEALS }
    const after = { items: [row('b', 'chicken')], meals: MEALS }
    expect(detectStapleRejections(before, after)).toEqual([stapleKey('olive oil')])
  })

  test('deleting the MEAL is not a rejection of its ingredients', () => {
    // The failure this prevents: changing your mind about Tuesday files every
    // ingredient of that recipe as something you always have.
    const before = {
      items: [row('a', 'chicken thighs'), row('b', 'gochujang')],
      meals: MEALS,
    }
    const after = { items: [], meals: [{ id: 'meal-2' }] }
    expect(detectStapleRejections(before, after)).toEqual([])
  })

  test('emptying a meal without deleting it is not a rejection either', () => {
    const before = { items: [row('a', 'chicken'), row('b', 'rice')], meals: MEALS }
    const after = { items: [], meals: MEALS }
    expect(detectStapleRejections(before, after)).toEqual([])
  })

  test('a row that was CHECKED and then deleted is tidying up, not a rejection', () => {
    const before = { items: [row('a', 'olive oil', { checked: true }), row('b', 'chicken')], meals: MEALS }
    const after = { items: [row('b', 'chicken')], meals: MEALS }
    expect(detectStapleRejections(before, after)).toEqual([])
  })

  test('a hand-typed row carries no signal — the app never put it there', () => {
    const before = {
      items: [{ id: 'a', text: 'birthday candles', checked: false, isSection: false }, row('b', 'chicken')],
      meals: MEALS,
    }
    const after = { items: [row('b', 'chicken')], meals: MEALS }
    expect(detectStapleRejections(before, after)).toEqual([])
  })

  test('sections are not ingredients', () => {
    const before = {
      items: [row('a', 'Produce', { isSection: true }), row('b', 'chicken'), row('c', 'rice')],
      meals: MEALS,
    }
    const after = { items: [row('b', 'chicken'), row('c', 'rice')], meals: MEALS }
    expect(detectStapleRejections(before, after)).toEqual([])
  })

  test('the same ingredient deleted from two meals counts once', () => {
    // One decision, not two — otherwise a single tidy-up promotes a staple.
    const before = {
      items: [
        row('a', 'olive oil', { mealId: 'meal-1' }),
        row('b', 'olive oil', { mealId: 'meal-2' }),
        row('c', 'chicken', { mealId: 'meal-1' }),
        row('d', 'rice', { mealId: 'meal-2' }),
      ],
      meals: MEALS,
    }
    const after = {
      items: [row('c', 'chicken', { mealId: 'meal-1' }), row('d', 'rice', { mealId: 'meal-2' })],
      meals: MEALS,
    }
    expect(detectStapleRejections(before, after)).toEqual([stapleKey('olive oil')])
  })

  test('different wordings of one ingredient collapse to one key', () => {
    const before = {
      items: [
        row('a', '2 tbsp Olive Oil', { mealId: 'meal-1' }),
        row('b', 'olive oil', { mealId: 'meal-2' }),
        row('c', 'chicken', { mealId: 'meal-1' }),
        row('d', 'rice', { mealId: 'meal-2' }),
      ],
      meals: MEALS,
    }
    const after = {
      items: [row('c', 'chicken', { mealId: 'meal-1' }), row('d', 'rice', { mealId: 'meal-2' })],
      meals: MEALS,
    }
    expect(detectStapleRejections(before, after)).toEqual([stapleKey('olive oil')])
  })

  test('an edit is not a deletion', () => {
    const before = { items: [row('a', 'milk'), row('b', 'chicken')], meals: MEALS }
    const after = { items: [row('a', '2% milk'), row('b', 'chicken')], meals: MEALS }
    expect(detectStapleRejections(before, after)).toEqual([])
  })

  test('checking a row off is not a deletion', () => {
    const before = { items: [row('a', 'olive oil'), row('b', 'chicken')], meals: MEALS }
    const after = { items: [row('a', 'olive oil', { checked: true }), row('b', 'chicken')], meals: MEALS }
    expect(detectStapleRejections(before, after)).toEqual([])
  })

  test('survives missing, empty and malformed documents', () => {
    expect(detectStapleRejections({}, {})).toEqual([])
    expect(detectStapleRejections({ items: null }, { items: null })).toEqual([])
    expect(detectStapleRejections({ items: [] }, { items: [] })).toEqual([])
    expect(detectStapleRejections({ items: [row('a', 'salt')] }, { items: [] })).toEqual([])
  })

  test('a row with unusable text is skipped rather than keyed as empty', () => {
    const before = { items: [row('a', '   '), row('b', 'chicken'), row('c', 'rice')], meals: MEALS }
    const after = { items: [row('b', 'chicken'), row('c', 'rice')], meals: MEALS }
    expect(detectStapleRejections(before, after)).toEqual([])
  })
})

describe('STAPLE_THRESHOLD', () => {
  test('is a real threshold, not one strike', () => {
    // One deletion is a decision about this week; three is a habit.
    expect(STAPLE_THRESHOLD).toBeGreaterThan(1)
  })
})
