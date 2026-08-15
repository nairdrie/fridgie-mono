// The data contract now lives in packages/shared, shared verbatim with the
// mobile app. `export type *` is fully erased, so this adds no runtime import.

export type * from '@fridgie/shared/types'

// Runtime value — cannot live in the type-only shared package.
export enum ListView {
  GroceryList = 'list',
  MealPlan = 'plan',
}
