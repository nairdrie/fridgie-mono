// Recipe yield and household scaling — see packages/shared/servings.ts.
//
// The rule the whole feature turns on: a recipe is NEVER rewritten. Scaling is
// applied at the one moment a recipe's ingredients become rows on a list, and
// the factor is recorded on the meal so the cooking view can show the amounts
// the shopping was actually done against.

export {
  describeScale,
  normalizeRecipeServings,
  parseServings,
  scaleIngredients,
  scaleQuantity,
  servingsScale,
} from '@fridgie/shared/servings';
