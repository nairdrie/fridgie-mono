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
  test('passes valid items through unchanged, without mutating the input', () => {
    const a = LexoRank.middle()
    const items = [
      { id: '1', text: 'a', listOrder: rank(a), isSection: false, checked: false },
      { id: '2', text: 'b', listOrder: rank(a.genNext()), isSection: false, checked: false },
    ]
    const snapshot = structuredClone(items)

    const result = sanitizeItems(items)

    expect(result.changed).toBe(false)
    expect(result.items).toEqual(snapshot)
    // sanitizeItems used to repair in place, which made the assertion above
    // compare the input against itself and pass no matter what it did.
    expect(items).toEqual(snapshot)
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
    const ranks = fixed.map((i) => LexoRank.parse(i.listOrder!))
    expect(ranks[1]!.compareTo(ranks[0]!)).toBeGreaterThan(0)
    expect(ranks[2]!.compareTo(ranks[1]!)).toBeGreaterThan(0)
  })

  test('is idempotent — a second pass reports no change', () => {
    const a = LexoRank.middle()
    const items = [
      { id: '1', listOrder: rank(a) },
      { id: '2', listOrder: 'NEEDS-RANK' },
      { id: '3', listOrder: rank(a.genNext().genNext()) },
    ]
    const first = sanitizeItems(items)
    expect(first.changed).toBe(true)

    const second = sanitizeItems(first.items)
    expect(second.changed).toBe(false)
    expect(second.items).toEqual(first.items)
  })

  test('repairs relative to the running max, not the previous array element', () => {
    // Persisted arrays are not guaranteed to be in rank order. Using the
    // preceding element as the anchor let a repaired item land arbitrarily.
    const a = LexoRank.middle()
    const b = a.genNext()
    const c = b.genNext()
    const items = [
      { id: 'c', listOrder: rank(c) },
      { id: 'a', listOrder: rank(a) },
      { id: 'broken', listOrder: 'NEEDS-RANK' },
      { id: 'b', listOrder: rank(b) },
    ]
    const { items: fixed } = sanitizeItems(items)
    const broken = fixed.find((i) => i.id === 'broken')!
    // Must sort after the highest valid rank seen before it (c), not after `a`.
    expect(LexoRank.parse(broken.listOrder!).compareTo(c)).toBeGreaterThan(0)
  })

  test('re-ranks exact duplicates so ordering never falls back to array position', () => {
    // The drag handler used to hand two items byte-identical ranks; a tie is
    // then broken by array order, which differs per device.
    const a = LexoRank.middle()
    const items = [
      { id: '1', listOrder: rank(a) },
      { id: '2', listOrder: rank(a) },
      { id: '3', listOrder: rank(a.genNext()) },
    ]
    const { items: fixed, changed } = sanitizeItems(items)
    expect(changed).toBe(true)

    const ranks = fixed.map((i) => i.listOrder)
    expect(new Set(ranks).size).toBe(3)
  })

  test('leaves a legitimately unsorted array alone', () => {
    // Array order is NOT rank order, so a rank that merely sorts before its
    // predecessor is valid and must not be rewritten.
    const a = LexoRank.middle()
    const b = a.genNext()
    const items = [
      { id: 'b', listOrder: rank(b) },
      { id: 'a', listOrder: rank(a) },
    ]
    const { items: fixed, changed } = sanitizeItems(items)
    expect(changed).toBe(false)
    expect(fixed.map((i) => i.listOrder)).toEqual([rank(b), rank(a)])
  })

  test('migrates the legacy order key', () => {
    const items = [{ id: '1', text: '', checked: false, order: LexoRank.middle().toString() }]
    const { items: fixed, changed } = sanitizeItems(items)
    expect(changed).toBe(true)
    expect(fixed[0]!.listOrder).toBe(LexoRank.middle().toString())
    expect(fixed[0]!.order).toBeUndefined()
  })

  test('assigns missing mealOrder for meal items', () => {
    const a = LexoRank.middle()
    const items = [
      { id: '1', mealId: 'm1', listOrder: rank(a) },
      { id: '2', mealId: 'm1', listOrder: rank(a.genNext()) },
    ]
    const { items: fixed, changed } = sanitizeItems(items)
    expect(changed).toBe(true)
    const m1 = LexoRank.parse(fixed[0]!.mealOrder!)
    const m2 = LexoRank.parse(fixed[1]!.mealOrder!)
    expect(m2.compareTo(m1)).toBeGreaterThan(0)
  })

  test('does not assign mealOrder to section rows', () => {
    const a = LexoRank.middle()
    const items = [
      { id: 's', mealId: 'm1', isSection: true, listOrder: rank(a) },
      { id: '1', mealId: 'm1', listOrder: rank(a.genNext()) },
    ]
    const { items: fixed } = sanitizeItems(items)
    expect(fixed[0]!.mealOrder).toBeUndefined()
    expect(fixed[1]!.mealOrder).toBeDefined()
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
    expect(fixed[0]!.overrideQuantity).toBe('2 cup')
    expect(fixed[0]!.overrideBase).toBe('1.13 cup')
    expect(fixed[0]!.someFutureField).toEqual({ nested: true })
  })

  test('drops RTDB array holes and tolerates object-shaped items', () => {
    const valid = { id: '1', listOrder: LexoRank.middle().toString() }
    expect(sanitizeItems([null, valid, undefined]).items).toEqual([valid])
    expect(sanitizeItems({ a: valid }).items).toEqual([valid])
    expect(sanitizeItems(undefined).items).toEqual([])
  })
})
