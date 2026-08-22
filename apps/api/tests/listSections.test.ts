import { describe, expect, test } from 'bun:test'
import { LexoRank } from 'lexorank'
import { dropEmptiedSections, type SectionRow } from '@fridgie/shared/listSections'

/**
 * Builds a list from a compact sketch:
 *   '#Produce'      a section heading
 *   'apples'        a plain row
 *   'apples@dinner' a row belonging to meal `dinner`
 *   'apples!'       a row that has been checked off
 */
function list(...rows: string[]): (SectionRow & { text: string; mealId?: string; checked: boolean })[] {
  let rank = LexoRank.middle()
  return rows.map((row, i) => {
    const listOrder = rank.toString()
    rank = rank.genNext()
    const isSection = row.startsWith('#')
    const body = isSection ? row.slice(1) : row
    const checked = body.endsWith('!')
    const [text = '', mealId] = (checked ? body.slice(0, -1) : body).split('@')
    return {
      id: `id-${i}-${text || 'blank'}`,
      text,
      isSection,
      checked,
      listOrder,
      ...(mealId ? { mealId } : {}),
    }
  })
}

/** Renders a result back into the same sketch, in rank order. */
const sketch = (rows: readonly (SectionRow & { text: string })[]): string[] =>
  [...rows]
    .sort((a, b) => String(a.listOrder).localeCompare(String(b.listOrder)))
    .map((r) => (r.isSection ? `#${r.text}` : r.text))

/** What deleting a meal does to the list — the app's own delete, in one line. */
const withoutMeal = <T extends SectionRow & { mealId?: string }>(
  rows: readonly T[],
  mealId: string,
): T[] => dropEmptiedSections(rows, rows.filter((r) => r.mealId !== mealId))

describe('dropEmptiedSections', () => {
  test('drops an aisle whose only rows belonged to the deleted meal', () => {
    const items = list('#Meat & Poultry', 'chicken@roast', '#Produce', 'potatoes@roast')

    expect(sketch(withoutMeal(items, 'roast'))).toEqual([])
  })

  test('keeps an aisle another meal is still using', () => {
    const items = list('#Produce', 'potatoes@roast', 'lettuce@salad', '#Bakery', 'buns@burgers')

    expect(sketch(withoutMeal(items, 'roast'))).toEqual(['#Produce', 'lettuce', '#Bakery', 'buns'])
  })

  test('keeps an aisle a hand-typed row is still using', () => {
    const items = list('#Dairy & Eggs', 'milk', 'butter@baking')

    expect(sketch(withoutMeal(items, 'baking'))).toEqual(['#Dairy & Eggs', 'milk'])
  })

  test('leaves a heading the user wrote and has not filled in yet', () => {
    // It was already empty before the delete, so the delete is not what
    // emptied it — the user is still on their way to putting something in it.
    const items = list('#Produce', 'apples@salad', '#Party Snacks')

    expect(sketch(withoutMeal(items, 'salad'))).toEqual(['#Party Snacks'])
  })

  test('keeps an aisle whose remaining rows are all checked off', () => {
    // Checked rows leave the aisle on screen but not off the list, and
    // unchecking one has to bring its heading back with it.
    const items = list('#Produce', 'apples!', 'potatoes@roast')

    expect(sketch(withoutMeal(items, 'roast'))).toEqual(['#Produce', 'apples'])
  })

  test('leaves rows that sit above the first heading alone', () => {
    const items = list('milk', '#Produce', 'potatoes@roast')

    expect(sketch(withoutMeal(items, 'roast'))).toEqual(['milk'])
  })

  test('reads the list in rank order, not array order', () => {
    // The stored array is not necessarily in rank order — RTDB hands it back
    // however it likes, and every add appends. Grouping by array position
    // would put `potatoes` under the wrong heading, or under none.
    const items = list('#Produce', 'potatoes@roast', '#Bakery', 'bread')
    const shuffled = [items[2]!, items[0]!, items[3]!, items[1]!]

    expect(sketch(withoutMeal(shuffled, 'roast'))).toEqual(['#Bakery', 'bread'])
  })

  test('drops several aisles at once', () => {
    const items = list(
      '#Bakery', 'buns@burgers',
      '#Meat & Poultry', 'beef@burgers', 'chicken@roast',
      '#Produce', 'lettuce@burgers',
    )

    expect(sketch(withoutMeal(items, 'burgers'))).toEqual(['#Meat & Poultry', 'chicken'])
  })

  test('hands back the same array when the delete emptied nothing', () => {
    const items = list('#Produce', 'apples', 'potatoes@roast')
    const after = items.filter((i) => i.mealId !== 'roast')

    expect(dropEmptiedSections(items, after)).toBe(after)
  })

  test('a delete that touches nothing changes nothing', () => {
    const items = list('#Produce', 'apples@salad')

    expect(sketch(withoutMeal(items, 'roast'))).toEqual(['#Produce', 'apples'])
  })
})
