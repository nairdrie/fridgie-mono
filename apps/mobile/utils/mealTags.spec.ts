import { describe, expect, test } from 'bun:test'
import { mealNameIndex, mealNamesForItems } from './mealTags'

/** An item with only the fields the backlink derivation reads. */
const item = (id: string, extra: Record<string, any> = {}): any => ({
  id,
  text: id,
  checked: false,
  listOrder: id,
  isSection: false,
  ...extra,
})

/** A meal with only the fields the backlink derivation reads. */
const meal = (id: string, name: string): any => ({ id, listId: 'w', name })

describe('mealNameIndex', () => {
  test('maps id to trimmed name', () => {
    const index = mealNameIndex([meal('m1', '  Tacos  '), meal('m2', 'Soup')])
    expect(index.get('m1')).toBe('Tacos')
    expect(index.get('m2')).toBe('Soup')
  })

  test('drops meals with a blank or missing name', () => {
    const index = mealNameIndex([meal('m1', ''), meal('m2', '   '), { id: 'm3', listId: 'w' } as any])
    expect(index.size).toBe(0)
  })
})

describe('mealNamesForItems', () => {
  const index = mealNameIndex([meal('m1', 'Tacos'), meal('m2', 'Soup')])

  test('returns the names of the meals the sources belong to', () => {
    const sources = [item('a', { mealId: 'm1' }), item('b', { mealId: 'm2' })]
    expect(mealNamesForItems(sources, index)).toEqual(['Tacos', 'Soup'])
  })

  test('ignores sources with no mealId — a hand-typed row', () => {
    const sources = [item('a'), item('b', { mealId: 'm1' })]
    expect(mealNamesForItems(sources, index)).toEqual(['Tacos'])
  })

  test('dedupes by meal id, keeping first-seen order', () => {
    const sources = [
      item('a', { mealId: 'm2' }),
      item('b', { mealId: 'm1' }),
      item('c', { mealId: 'm2' }),
    ]
    expect(mealNamesForItems(sources, index)).toEqual(['Soup', 'Tacos'])
  })

  test('skips a mealId that is not in the index — unnamed or deleted meal', () => {
    const sources = [item('a', { mealId: 'gone' }), item('b', { mealId: 'm1' })]
    expect(mealNamesForItems(sources, index)).toEqual(['Tacos'])
  })

  test('two meals that share a name are both counted', () => {
    const dupIndex = mealNameIndex([meal('m1', 'Salad'), meal('m2', 'Salad')])
    const sources = [item('a', { mealId: 'm1' }), item('b', { mealId: 'm2' })]
    expect(mealNamesForItems(sources, dupIndex)).toEqual(['Salad', 'Salad'])
  })

  test('no meal-linked sources yields an empty list', () => {
    expect(mealNamesForItems([item('a'), item('b')], index)).toEqual([])
  })
})
