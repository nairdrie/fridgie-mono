import { describe, expect, test } from 'bun:test'
import { AisleRow, reorderByAisle } from './aisleOrder'

const heading = (name: string): AisleRow => ({ id: `h-${name}`, text: name, isSection: true })
const row = (text: string, section: string | undefined, extra: Partial<AisleRow> = {}): AisleRow =>
  ({ id: text, text, section, sourceIds: [text], ...extra })

const ids = (rows: AisleRow[]) => rows.map(r => r.id)
const byId = (all: AisleRow[]) => (...wanted: string[]) => wanted.map(id => all.find(r => r.id === id)!)

describe('reorderByAisle', () => {
  const produce = heading('Produce')
  const dairy = heading('Dairy')
  const bakery = heading('Bakery')
  const apples = row('apples', 'Produce')
  const kale = row('kale', 'Produce')
  const milk = row('milk', 'Dairy')
  const eggs = row('eggs', 'Dairy', { checked: true })
  const bread = row('bread', 'Bakery')
  const draft = row('draft', undefined)
  const all = [produce, apples, kale, dairy, milk, eggs, bakery, bread, draft]
  const pick = byId(all)

  test('a heading dragged down takes its whole aisle, hidden rows included', () => {
    // Produce was folded for the drag, so only its heading was on screen.
    const shown = pick('h-Dairy', 'milk', 'h-Bakery', 'bread', 'h-Produce')
    const { ordered, refiled } = reorderByAisle(all, shown)
    expect(ids(ordered)).toEqual([
      'h-Dairy', 'milk', 'eggs', 'h-Bakery', 'bread', 'h-Produce', 'apples', 'kale', 'draft',
    ])
    expect(refiled.size).toBe(0)
  })

  test('a checked row keeps its place inside its aisle', () => {
    const shown = pick('h-Produce', 'kale', 'apples', 'h-Dairy', 'milk', 'h-Bakery', 'bread')
    const { ordered } = reorderByAisle(all, shown)
    expect(ids(ordered)).toEqual([
      'h-Produce', 'kale', 'apples', 'h-Dairy', 'milk', 'eggs', 'h-Bakery', 'bread', 'draft',
    ])
  })

  test('a row dropped under another heading is refiled there', () => {
    const shown = pick('h-Produce', 'apples', 'kale', 'h-Dairy', 'h-Bakery', 'milk', 'bread')
    const { ordered, refiled } = reorderByAisle(all, shown)
    expect(ids(ordered)).toEqual([
      'h-Produce', 'apples', 'kale', 'h-Dairy', 'eggs', 'h-Bakery', 'milk', 'bread', 'draft',
    ])
    expect([...refiled]).toEqual([['milk', 'Bakery']])
  })

  test('a heading with everything checked stays behind the aisle it followed', () => {
    const allDone = [produce, apples, dairy, { ...milk, checked: true }, bakery, bread]
    const pickDone = byId(allDone)
    // Dairy is off screen: nothing left to buy in it.
    const shown = pickDone('h-Bakery', 'bread', 'h-Produce', 'apples')
    const { ordered } = reorderByAisle(allDone, shown)
    expect(ids(ordered)).toEqual(['h-Bakery', 'bread', 'h-Produce', 'apples', 'h-Dairy', 'milk'])
  })

  test('every row comes out exactly once', () => {
    const shown = pick('h-Bakery', 'bread', 'h-Dairy', 'milk', 'h-Produce', 'kale', 'apples')
    const { ordered } = reorderByAisle(all, shown)
    expect(ids(ordered).sort()).toEqual(ids(all).sort())
  })
})
