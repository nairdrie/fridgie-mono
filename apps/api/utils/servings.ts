// Recipe yield and household scaling. The implementation lives in
// packages/shared alongside the quantity engine it builds on, so a `servings`
// this server stores is read the same way by the client that scales against
// it. This file is a re-export shim, matching `quantity.ts` next door.

export {
  describeScale,
  MAX_SERVINGS_SCALE,
  MIN_SERVINGS_SCALE,
  normalizeRecipeServings,
  parseServings,
  scaleIngredients,
  scaleQuantity,
  servingsForScale,
  servingsRange,
  servingsScale,
} from '@fridgie/shared/servings'
