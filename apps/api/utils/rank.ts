import { LexoRank } from 'lexorank'

export function safeParseRank(value: unknown): LexoRank | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    return LexoRank.parse(value)
  } catch {
    return null
  }
}

type RankField = 'listOrder' | 'mealOrder'

// Repairs `field` across `items` in array order: any value that doesn't parse
// as a LexoRank is replaced with a rank between its valid neighbours, so the
// surrounding order is preserved.
function repairRanks(items: any[], field: RankField): boolean {
  let changed = false
  let prev: LexoRank | null = null
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    let rank = safeParseRank(item[field])
    if (!rank) {
      let next: LexoRank | null = null
      for (let j = i + 1; j < items.length; j++) {
        const candidate = safeParseRank(items[j][field])
        if (candidate && (!prev || candidate.compareTo(prev) > 0)) {
          next = candidate
          break
        }
      }
      if (prev && next) rank = prev.between(next)
      else if (prev) rank = prev.genNext()
      else if (next) rank = next.genPrev()
      else rank = LexoRank.middle()
      item[field] = rank.toString()
      changed = true
    }
    prev = rank
  }
  return changed
}

/**
 * Write-time validation/repair for a list's items[] (backend handoff §3.2).
 * - drops null/non-object entries (RTDB array holes)
 * - migrates the legacy `order` key to `listOrder`
 * - replaces any `listOrder` that doesn't parse as a LexoRank (e.g. the
 *   literal 'NEEDS-RANK' some clients persisted)
 * - ensures meal-ingredient items have a parseable `mealOrder`
 * Unknown item fields (overrideQuantity, overrideBase, ...) are left untouched:
 * Item is treated as open/extensible per handoff §3.1.
 */
export function sanitizeItems(rawItems: unknown): { items: any[]; changed: boolean } {
  const source = Array.isArray(rawItems)
    ? rawItems
    : rawItems && typeof rawItems === 'object'
      ? Object.values(rawItems)
      : []
  const items = source.filter((i) => i && typeof i === 'object')
  let changed = items.length !== source.length

  for (const item of items) {
    if (item.listOrder === undefined && typeof item.order === 'string') {
      item.listOrder = item.order
      delete item.order
      changed = true
    }
  }

  if (repairRanks(items, 'listOrder')) changed = true

  // Meal ingredients are ordered within their meal via mealOrder.
  const mealGroups = new Map<string, any[]>()
  for (const item of items) {
    if (item.mealId && !item.isSection) {
      const group = mealGroups.get(item.mealId) ?? []
      group.push(item)
      mealGroups.set(item.mealId, group)
    }
  }
  for (const group of mealGroups.values()) {
    if (repairRanks(group, 'mealOrder')) changed = true
  }

  return { items, changed }
}
