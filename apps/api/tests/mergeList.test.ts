import { describe, expect, test } from 'bun:test'
import { mergeListDocuments, mergeRows } from '@fridgie/shared/mergeList'

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: id,
  checked: false,
  isSection: false,
  listOrder: '0|100000:',
  ...over,
})

const doc = (items: any[], meals: any[] = []) => ({ items, meals })

describe('concurrent adds', () => {
  test('rows added on both sides all survive', () => {
    const base = doc([item('a')])
    const local = doc([item('a'), item('mine')])
    const remote = doc([item('a'), item('theirs')])

    const { items, conflicts } = mergeListDocuments(base, local, remote)

    expect(items.map((i) => i.id).sort()).toEqual(['a', 'mine', 'theirs'])
    expect(conflicts).toEqual([])
  })

  test('a whole offline shop merges with a whole remote shop', () => {
    const base = doc([item('a')])
    const local = doc([item('a', { checked: true }), item('l1'), item('l2'), item('l3')])
    const remote = doc([item('a'), item('r1'), item('r2')])

    const { items } = mergeListDocuments(base, local, remote)

    expect(items).toHaveLength(6)
    expect(items.find((i) => i.id === 'a')?.checked).toBe(true)
  })
})

describe('single-sided field changes', () => {
  test('a local change to a field the other side left alone wins outright', () => {
    const base = doc([item('a', { text: 'milk' })])
    const local = doc([item('a', { text: '2% milk' })])
    const remote = doc([item('a', { text: 'milk' })])

    const { items, conflicts } = mergeListDocuments(base, local, remote)

    expect(items[0]!.text).toBe('2% milk')
    expect(conflicts).toEqual([])
  })

  test('a remote change to a field the local side left alone is adopted', () => {
    const base = doc([item('a', { section: undefined })])
    const local = doc([item('a')])
    const remote = doc([item('a', { section: 'Produce' })])

    const { items } = mergeListDocuments(base, local, remote)

    expect(items[0]!.section).toBe('Produce')
  })

  test('different fields of the same row do not conflict', () => {
    const base = doc([item('a', { text: 'milk', checked: false })])
    const local = doc([item('a', { text: '2% milk', checked: false })])
    const remote = doc([item('a', { text: 'milk', checked: true })])

    const { items, conflicts } = mergeListDocuments(base, local, remote)

    expect(items[0]!.text).toBe('2% milk')
    expect(items[0]!.checked).toBe(true)
    expect(conflicts).toEqual([])
  })
})

describe('same-field collisions', () => {
  test('the newer updatedAt wins', () => {
    const base = doc([item('a', { text: 'milk' })])
    const local = doc([item('a', { text: 'oat milk', updatedAt: 2000 })])
    const remote = doc([item('a', { text: 'soy milk', updatedAt: 1000 })])

    const { items, conflicts } = mergeListDocuments(base, local, remote)

    expect(items[0]!.text).toBe('oat milk')
    // Local won, so there is nothing to tell the user about.
    expect(conflicts).toEqual([])
  })

  test('losing locally is reported, with both values', () => {
    const base = doc([item('a', { text: 'milk' })])
    const local = doc([item('a', { text: 'oat milk', updatedAt: 1000 })])
    const remote = doc([item('a', { text: 'soy milk', updatedAt: 2000 })])

    const { items, conflicts } = mergeListDocuments(base, local, remote)

    expect(items[0]!.text).toBe('soy milk')
    expect(conflicts).toEqual([
      {
        id: 'a',
        label: 'soy milk',
        field: 'text',
        winner: 'remote',
        localValue: 'oat milk',
        remoteValue: 'soy milk',
      },
    ])
  })

  test('equal stamps go to remote by default, and to local when asked', () => {
    const base = doc([item('a', { text: 'milk' })])
    const local = doc([item('a', { text: 'oat milk', updatedAt: 500 })])
    const remote = doc([item('a', { text: 'soy milk', updatedAt: 500 })])

    expect(mergeListDocuments(base, local, remote).items[0]!.text).toBe('soy milk')
    expect(
      mergeListDocuments(base, local, remote, { tieBreak: 'local' }).items[0]!.text
    ).toBe('oat milk')
  })

  test('both sides making the SAME change is not a conflict', () => {
    const base = doc([item('a', { checked: false })])
    const local = doc([item('a', { checked: true, updatedAt: 1 })])
    const remote = doc([item('a', { checked: true, updatedAt: 2 })])

    const { items, conflicts } = mergeListDocuments(base, local, remote)

    expect(items[0]!.checked).toBe(true)
    expect(conflicts).toEqual([])
  })

  test('the merged row carries the newer stamp forward', () => {
    const base = doc([item('a', { text: 'milk' })])
    const local = doc([item('a', { text: 'oat milk', updatedAt: 900 })])
    const remote = doc([item('a', { quantity: '2 L', updatedAt: 1700 })])

    const { items } = mergeListDocuments(base, local, remote)

    expect(items[0]!.updatedAt).toBe(1700)
  })
})

describe('delete versus edit', () => {
  test('a rename brings back a row the other side deleted', () => {
    const base = doc([item('a', { text: 'milk' })])
    const local = doc([item('a', { text: '2% milk' })])
    const remote = doc([])

    const { items } = mergeListDocuments(base, local, remote)

    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('2% milk')
  })

  test('a quantity change brings it back too', () => {
    const base = doc([item('a', { quantity: '1 L' })])
    const local = doc([item('a', { quantity: '2 L' })])
    const remote = doc([])

    expect(mergeListDocuments(base, local, remote).items).toHaveLength(1)
  })

  test('checking it off does NOT bring it back', () => {
    const base = doc([item('a', { checked: false })])
    const local = doc([item('a', { checked: true })])
    const remote = doc([])

    expect(mergeListDocuments(base, local, remote).items).toEqual([])
  })

  test('dragging it, or the server filing it, does not bring it back either', () => {
    const base = doc([item('a')])
    const local = doc([item('a', { listOrder: '0|zzzzzz:', section: 'Dairy' })])
    const remote = doc([])

    expect(mergeListDocuments(base, local, remote).items).toEqual([])
  })

  test('an untouched row the other side deleted stays deleted', () => {
    const base = doc([item('a'), item('b')])
    const local = doc([item('a'), item('b')])
    const remote = doc([item('a')])

    expect(mergeListDocuments(base, local, remote).items.map((i) => i.id)).toEqual(['a'])
  })

  test('the rule is symmetric — a remote rename survives a local delete', () => {
    const base = doc([item('a', { text: 'milk' })])
    const local = doc([])
    const remote = doc([item('a', { text: 'oat milk' })])

    const { items } = mergeListDocuments(base, local, remote)

    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('oat milk')
  })

  test('a remote check-off does not survive a local delete', () => {
    const base = doc([item('a', { checked: false })])
    const local = doc([])
    const remote = doc([item('a', { checked: true })])

    expect(mergeListDocuments(base, local, remote).items).toEqual([])
  })

  test('both sides deleting the same row is agreement, not conflict', () => {
    const base = doc([item('a'), item('b')])
    const local = doc([item('a')])
    const remote = doc([item('a')])

    const { items, conflicts } = mergeListDocuments(base, local, remote)

    expect(items.map((i) => i.id)).toEqual(['a'])
    expect(conflicts).toEqual([])
  })
})

describe('section headings', () => {
  test('are matched by label, not by their regenerated uuid', () => {
    // The server mints a fresh uuid for a heading every time it categorizes,
    // so the same "Produce" heading has a different id on each side.
    const base = doc([])
    const local = doc([item('local-uuid', { text: 'Produce', isSection: true })])
    const remote = doc([item('remote-uuid', { text: 'Produce', isSection: true })])

    const { items } = mergeListDocuments(base, local, remote)

    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('Produce')
  })

  test('matching ignores case', () => {
    const local = doc([item('l', { text: 'Produce', isSection: true })])
    const remote = doc([item('r', { text: 'produce', isSection: true })])

    expect(mergeListDocuments(doc([]), local, remote).items).toHaveLength(1)
  })

  test('genuinely different headings both survive', () => {
    const local = doc([item('l', { text: 'Produce', isSection: true })])
    const remote = doc([item('r', { text: 'Dairy', isSection: true })])

    expect(mergeListDocuments(doc([]), local, remote).items).toHaveLength(2)
  })
})

describe('reordering', () => {
  test('a local drag survives a remote edit to another field', () => {
    const base = doc([item('a', { listOrder: '0|100000:' })])
    const local = doc([item('a', { listOrder: '0|300000:' })])
    const remote = doc([item('a', { listOrder: '0|100000:', checked: true })])

    const { items } = mergeListDocuments(base, local, remote)

    expect(items[0]!.listOrder).toBe('0|300000:')
    expect(items[0]!.checked).toBe(true)
  })

  test('two people moving the same row resolve to the newer move', () => {
    const base = doc([item('a', { listOrder: '0|100000:' })])
    const local = doc([item('a', { listOrder: '0|200000:', updatedAt: 5 })])
    const remote = doc([item('a', { listOrder: '0|300000:', updatedAt: 9 })])

    expect(mergeListDocuments(base, local, remote).items[0]!.listOrder).toBe('0|300000:')
  })
})

describe('null and undefined', () => {
  test('a round trip through RTDB does not register as an edit', () => {
    // RTDB drops undefined keys and hands some back as null.
    const base = doc([item('a', { section: undefined, mealId: undefined })])
    const local = doc([item('a', { section: null, mealId: null })])
    const remote = doc([item('a', { section: 'Produce' })])

    const { items, conflicts } = mergeListDocuments(base, local, remote)

    expect(items[0]!.section).toBe('Produce')
    expect(conflicts).toEqual([])
  })
})

describe('a missing base', () => {
  test('degrades to keep-everything rather than losing rows', () => {
    const local = doc([item('a', { text: 'oat milk', updatedAt: 9 }), item('mine')])
    const remote = doc([item('a', { text: 'soy milk', updatedAt: 1 }), item('theirs')])

    const { items } = mergeListDocuments(null, local, remote)

    expect(items.map((i) => i.id).sort()).toEqual(['a', 'mine', 'theirs'])
    // With no base, every field looks changed on both sides, so the stamp decides.
    expect(items.find((i) => i.id === 'a')?.text).toBe('oat milk')
  })

  test('never deletes, because it cannot tell a delete from an add', () => {
    const local = doc([item('a')])
    const remote = doc([item('b')])

    expect(mergeListDocuments(null, local, remote).items).toHaveLength(2)
  })
})

describe('changed', () => {
  test('is false when the merge produced exactly what the server already has', () => {
    const base = doc([item('a')])
    const local = doc([item('a')])
    const remote = doc([item('a'), item('theirs')])

    const { changed } = mergeListDocuments(base, local, remote)

    expect(changed).toBe(false)
  })

  test('is true when the local side contributed something', () => {
    const base = doc([item('a')])
    const local = doc([item('a', { checked: true })])
    const remote = doc([item('a'), item('theirs')])

    expect(mergeListDocuments(base, local, remote).changed).toBe(true)
  })
})

describe('meals', () => {
  // Return type widened explicitly. Without it TypeScript infers the narrow
  // shape from the first call site and then rejects `dayOfWeek`/`recipeId` on
  // the others, because mergeListDocuments is generic in the meal type.
  const meal = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    listId: 'L',
    name: id,
    ...over,
  })

  test('merge by the same rules as items', () => {
    const base = { items: [], meals: [meal('m', { name: 'Tacos' })] }
    const local = { items: [], meals: [meal('m', { name: 'Tacos', dayOfWeek: 'Monday' })] }
    const remote = { items: [], meals: [meal('m', { name: 'Tacos', recipeId: 'r1' })] }

    const { meals, conflicts } = mergeListDocuments(base, local, remote)

    expect(meals[0]!.dayOfWeek).toBe('Monday')
    expect(meals[0]!.recipeId).toBe('r1')
    expect(conflicts).toEqual([])
  })

  test('a rename resurrects a deleted meal but a cookbook toggle does not', () => {
    const base = { items: [], meals: [meal('m', { name: 'Tacos' })] }
    const renamed = { items: [], meals: [meal('m', { name: 'Burritos' })] }
    const toggled = { items: [], meals: [meal('m', { name: 'Tacos', addedToCookbook: true })] }
    const gone = { items: [], meals: [] }

    expect(mergeListDocuments(base, renamed, gone).meals).toHaveLength(1)
    expect(mergeListDocuments(base, toggled, gone).meals).toHaveLength(0)
  })
})

describe('unknown fields', () => {
  test('a key this build has never heard of is carried through', () => {
    const base = doc([item('a')])
    const local = doc([item('a', { checked: true })])
    const remote = doc([item('a', { someFutureField: 'keep me' })])

    const { items } = mergeListDocuments(base, local, remote)

    expect(items[0]!.someFutureField).toBe('keep me')
    expect(items[0]!.checked).toBe(true)
  })
})

describe('mergeRows', () => {
  test('preserves remote order, with local-only rows after', () => {
    const base = [item('a'), item('b')]
    const local = [item('a'), item('b'), item('z')]
    const remote = [item('b'), item('a')]

    const { rows } = mergeRows(base, local, remote)

    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'z'])
  })

  test('tolerates junk rows in the stored array', () => {
    const { rows } = mergeRows(
      [item('a')],
      [item('a'), null as any, undefined as any],
      [item('a')]
    )

    expect(rows.map((r) => r.id)).toEqual(['a'])
  })
})
