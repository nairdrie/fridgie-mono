// The data contract now lives in packages/shared, shared verbatim with the API.
// `export type *` is fully erased at compile time, so Metro never resolves it.

export type * from '@fridgie/shared/types';

// Runtime value — cannot live in the type-only shared package.
export enum ListView {
  GroceryList = 'list',
  MealPlan = 'plan',
}
