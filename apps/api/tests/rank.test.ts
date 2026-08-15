import { describe, expect, test } from 'bun:test'
import { LexoRank } from 'lexorank'
import { safeParseRank, sanitizeItems } from '../utils/rank'

const rank = (r: LexoRank) => r.toString()

describe('safeParseRank', () => {
  test('parses valid ranks and rejects garbage', () => {
    expect(safeParseRank(LexoRank.middle().toString())).not.toBeNull()
    expect(safeParseRank('NEEDS-RANK')).toBeNull()
    expect(safeParseRank('')).toBeNull()
    expect(safeParseRank(undefined)).toBeNull()
    expect(safeParseRank(42)).toBeNull()
  })
})

describe('sanitizeItems', () => {
  test('passes valid items through unchanged', () => {
    const a = LexoRank.middle()
    const items = [
      { id: '1', text: 'a', listOrder: rank(a), isSection: false, checked: false },
      { id: '2', text: 'b', listOrder: rank(a.genNext()), isSection: false, checked: false },
    ]
    const result = sanitizeItems(items)
    expect(result.changed).toBe(false)
    expect(result.items).toEqual(items)
  })

  test('repairs NEEDS-RANK while preserving array order', () => {
    const a = LexoRank.middle()
    const c = a.genNext().genNext()
    const items = [
      { id: '1', listOrder: rank(a) },
      { id: '2', listOrder: 'NEEDS-RANK' },
      { id: '3', listOrder: rank(c) },
    ]
    const { items: fixed, changed } = sanitizeItems(items)
    expect(changed).toBe(true)
    const ranks = fixed.map((i) => LexoRank.parse(i.listOrder))
    expect(ranks[1]!.compareTo(ranks[0]!)).toBeGreaterThan(0)
    expect(ranks[2]!.compareTo(ranks[1]!)).toBeGreaterThan(0)
  })

  test('migrates the legacy order key', () => {
    const items = [{ id: '1', text: '', checked: false, order: LexoRank.middle().toString() }]
    const { items: fixed, changed } = sanitizeItems(items)
    expect(changed).toBe(true)
    expect(fixed[0].listOrder).toBe(LexoRank.middle().toString())
    expect(fixed[0].order).toBeUndefined()
  })

  test('assigns missing mealOrder for meal items', () => {
    const a = LexoRank.middle()
    const items = [
      { id: '1', mealId: 'm1', listOrder: rank(a) },
      { id: '2', mealId: 'm1', listOrder: rank(a.genNext()) },
    ]
    const { items: fixed, changed } = sanitizeItems(items)
    expect(changed).toBe(true)
    const m1 = LexoRank.parse(fixed[0].mealOrder)
    const m2 = LexoRank.parse(fixed[1].mealOrder)
    expect(m2.compareTo(m1)).toBeGreaterThan(0)
  })

  test('preserves unknown item fields', () => {
    const items = [
      {
        id: '1',
        listOrder: 'NEEDS-RANK',
        overrideQuantity: '2 cup',
        overrideBase: '1.13 cup',
        someFutureField: { nested: true },
      },
    ]
    const { items: fixed } = sanitizeItems(items)
    expect(fixed[0].overrideQuantity).toBe('2 cup')
    expect(fixed[0].overrideBase).toBe('1.13 cup')
    expect(fixed[0].someFutureField).toEqual({ nested: true })
  })

  test('drops RTDB array holes and tolerates object-shaped items', () => {
    const valid = { id: '1', listOrder: LexoRank.middle().toString() }
    expect(sanitizeItems([null, valid, undefined]).items).toEqual([valid])
    expect(sanitizeItems({ a: valid }).items).toEqual([valid])
    expect(sanitizeItems(undefined).items).toEqual([])
  })
})
