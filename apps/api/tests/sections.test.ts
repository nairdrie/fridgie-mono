import { describe, expect, test } from 'bun:test'
import { LexoRank } from 'lexorank'
import { keepUnanswered, placeItems, type PlaceableItem } from '../utils/sections'

/** Builds a list from a compact `['#Produce', 'apples', ...]` sketch. */
function list(...rows: string[]): PlaceableItem[] {
  let rank = LexoRank.middle()
  return rows.map((row, i) => {
    const listOrder = rank.toString()
    rank = rank.genNext()
    const isSection = row.startsWith('#')
    const text = isSection ? row.slice(1) : row
    return { id: `id-${i}-${text || 'blank'}`, text, isSection, checked: false, listOrder }
  })
}

/** Renders a result back into the same sketch, in rank order. */
function sketch(items: PlaceableItem[]): string[] {
  return [...items]
    .sort((a, b) => String(a.listOrder).localeCompare(String(b.listOrder)))
    .map((i) => (i.isSection ? `#${i.text}` : String(i.text)))
}

const idOf = (items: PlaceableItem[], text: string) => items.find((i) => i.text === text)!.id

describe('placeItems', () => {
  test('creates the first section on a list that has none', () => {
    const items = list('milk')
    const result = placeItems(items, new Map([[idOf(items, 'milk'), 'Dairy & Eggs']]))

    expect(sketch(result)).toEqual(['#Dairy & Eggs', 'milk'])
    expect(result.find((i) => i.text === 'milk')!.section).toBe('Dairy & Eggs')
  })

  test('files an item into a section that already exists', () => {
    const items = list('#Dairy & Eggs', 'milk', '#Produce', 'apples', 'butter')
    const result = placeItems(items, new Map([[idOf(items, 'butter'), 'Dairy & Eggs']]))

    expect(sketch(result)).toEqual(['#Dairy & Eggs', 'milk', 'butter', '#Produce', 'apples'])
  })

  test('inserts a new section in alphabetical position', () => {
    const items = list('#Bakery', 'bread', '#Produce', 'apples', 'salmon')
    const result = placeItems(items, new Map([[idOf(items, 'salmon'), 'Meat & Poultry']]))

    expect(sketch(result)).toEqual([
      '#Bakery', 'bread', '#Meat & Poultry', 'salmon', '#Produce', 'apples',
    ])
  })

  test('appends a new section that sorts after every existing one', () => {
    const items = list('#Bakery', 'bread', 'apples')
    const result = placeItems(items, new Map([[idOf(items, 'apples'), 'Produce']]))

    expect(sketch(result)).toEqual(['#Bakery', 'bread', '#Produce', 'apples'])
  })

  test('leaves an item that is already in the right section exactly where it is', () => {
    const items = list('#Produce', 'apples', 'bananas', 'carrots')
    const result = placeItems(items, new Map([[idOf(items, 'apples'), 'Produce']]))

    // Re-filing after an edit must not shunt the row to the bottom of its aisle.
    expect(sketch(result)).toEqual(['#Produce', 'apples', 'bananas', 'carrots'])
  })

  test('does not touch rows that were not asked about', () => {
    const items = list('#Produce', 'apples', '#Bakery', 'bread', 'milk')
    const result = placeItems(items, new Map([[idOf(items, 'milk'), 'Dairy & Eggs']]))

    // Produce stays above Bakery: existing headings keep the order they had.
    expect(sketch(result)).toEqual([
      '#Produce', 'apples', '#Bakery', 'bread', '#Dairy & Eggs', 'milk',
    ])
  })

  test('drops a heading left with nothing under it', () => {
    const items = list('#Produce', 'apples', '#Bakery', 'bread')
    const result = placeItems(items, new Map([[idOf(items, 'bread'), 'Produce']]))

    expect(sketch(result)).toEqual(['#Produce', 'apples', 'bread'])
  })

  test('pushes blank placeholder rows to the end, outside every section', () => {
    const items = list('', '#Produce', 'apples', 'milk', '')
    const result = placeItems(items, new Map([[idOf(items, 'milk'), 'Dairy & Eggs']]))

    expect(sketch(result)).toEqual(['#Dairy & Eggs', 'milk', '#Produce', 'apples', '', ''])
  })

  test('stamps the section on every filed row and clears it above the first heading', () => {
    const items = list('#Produce', 'apples', 'milk')
    items.find((i) => i.text === 'milk')!.section = 'Frozen Foods'
    const result = placeItems(items, new Map([[idOf(items, 'milk'), 'Dairy & Eggs']]))

    const bySection = Object.fromEntries(
      result.filter((i) => !i.isSection).map((i) => [i.text, i.section]),
    )
    expect(bySection).toEqual({ apples: 'Produce', milk: 'Dairy & Eggs' })
  })

  test('gives every row a distinct, parseable rank', () => {
    const items = list('#Produce', 'apples', 'milk', 'bread', '')
    const result = placeItems(
      items,
      new Map([
        [idOf(items, 'milk'), 'Dairy & Eggs'],
        [idOf(items, 'bread'), 'Bakery'],
      ]),
    )

    const ranks = result.map((i) => String(i.listOrder))
    expect(new Set(ranks).size).toBe(ranks.length)
    for (const rank of ranks) expect(() => LexoRank.parse(rank)).not.toThrow()
    expect(sketch(result)).toEqual([
      '#Bakery', 'bread', '#Dairy & Eggs', 'milk', '#Produce', 'apples', '',
    ])
  })

  test('ignores placements for ids that are not on the list', () => {
    const items = list('#Produce', 'apples')
    const result = placeItems(items, new Map([['ghost', 'Bakery']]))

    expect(sketch(result)).toEqual(['#Produce', 'apples'])
  })

  test('keeps the objects it moves intact apart from rank and section', () => {
    const items = list('milk')
    items[0]!.quantity = '2 L'
    items[0]!.mealId = 'meal-1'
    const result = placeItems(items, new Map([[idOf(items, 'milk'), 'Dairy & Eggs']]))

    const milk = result.find((i) => i.text === 'milk')!
    expect(milk.quantity).toBe('2 L')
    expect(milk.mealId).toBe('meal-1')
    expect(milk.id).toBe(items[0]!.id)
  })
})

describe('keepUnanswered', () => {
  test('puts back a row that arrived while we were categorizing', () => {
    const filed = list('#Produce', 'apples')
    const stored = [...filed, { id: 'late', text: 'milk', isSection: false, checked: false, listOrder: 'zzz' }]

    const result = keepUnanswered(filed, stored)

    expect(sketch(result)).toEqual(['#Produce', 'apples', 'milk'])
    // On the end and unfiled, so the next pass gives it an aisle.
    expect(result.find((i) => i.id === 'late')!.section).toBeUndefined()
  })

  test('keeps rows the database has not seen — they are the caller unsaved edits', () => {
    const filed = list('#Produce', 'apples')
    const result = keepUnanswered(filed, [])

    expect(sketch(result)).toEqual(['#Produce', 'apples'])
  })

  test('returns the answer untouched when nothing was missed', () => {
    const filed = list('#Produce', 'apples')
    expect(keepUnanswered(filed, filed)).toBe(filed)
  })
})
