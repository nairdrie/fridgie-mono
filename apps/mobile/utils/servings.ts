// Recipe yield and household scaling — see packages/shared/servings.ts.
//
// The rule the whole feature turns on: a recipe is NEVER rewritten. Scaling is
// applied at the one moment a recipe's ingredients become rows on a list, and
// the factor is recorded on the meal so the cooking view can show the amounts
// the shopping was actually done against.
//
// The recipe screen scales for DISPLAY too — the servings stepper multiplies
// what is on screen and nothing else. Same rule: the stored document keeps the
// author's numbers.

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
} from '@fridgie/shared/servings';
