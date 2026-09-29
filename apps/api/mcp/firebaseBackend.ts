import { adminRtdb, fs } from '@/utils/firebase'
import { sanitizeItems } from '@/utils/rank'
import { findOrCreateWeekList } from '@/utils/weekLists'
import { addRecipeToList, appendToList } from '@/utils/mealPlan'
import { addToCookbook } from '@/utils/cookbookStore'
import { createRecipe, getRecipeDoc } from '@/utils/recipeStore'
import { getCookbook } from '@/api/cookbook'
import type { Item, Meal, MealPreferences, Recipe } from '@/utils/types'
import type { FridgieBackend, Household } from './backend'

const asArray = <T>(value: unknown): T[] =>
  Array.isArray(value) ? value.filter(Boolean) : value && typeof value === 'object' ? Object.values(value as object) : []

export const firebaseBackend: FridgieBackend = {
  async listHouseholds(uid) {
    // The same whole-tree read GET /api/group does: groups are keyed by id,
    // not by member, and there is no index on membership to query instead.
    const all = ((await adminRtdb.ref('groups').once('value')).val() || {}) as Record<string, any>
    return Object.entries(all)
      .filter(([, g]) => g?.members?.[uid])
      .map(([id, g]): Household => ({
        id,
        name: String(g.name ?? 'Household'),
        isOwner: g.owner === uid,
        memberCount: Object.keys(g.members ?? {}).length,
        ...(typeof g.householdSize === 'number' ? { householdSize: g.householdSize } : {}),
      }))
  },

  async getWeekList(groupId, weekStart, legacyWeekStart) {
    const { listId } = await findOrCreateWeekList(groupId, weekStart, legacyWeekStart)
    const list = ((await adminRtdb.ref(`lists/${groupId}/${listId}`).once('value')).val() || {}) as Record<string, any>
    return {
      listId,
      weekStart: String(list.weekStart ?? weekStart).slice(0, 10),
      sort: list.sort ?? 'category',
      meals: asArray<Meal>(list.meals),
      items: sanitizeItems(list.items).items as unknown as Item[],
    }
  },

  async appendItems(groupId, listId, rows) {
    const result = await appendToList(groupId, listId, rows)
    if (result.status !== 'ok') throw new Error('That week\'s list no longer exists.')
    return result.items
  },

  async addRecipeToList(groupId, listId, recipe, options) {
    const result = await addRecipeToList(groupId, listId, recipe, options)
    if (result.status !== 'ok') throw new Error('That week\'s list no longer exists.')
    return { meal: result.meal, items: result.items }
  },

  createRecipe,
  addToCookbook,

  async getRecipe(recipeId) {
    return getRecipeDoc(recipeId)
  },

  async getCookbook(uid) {
    return (await getCookbook(uid)) as unknown as Recipe[]
  },

  async getPreferences(uid) {
    const doc = await fs.collection('users').doc(uid).get()
    return (doc.data()?.preferences as MealPreferences | undefined) ?? null
  },
}
