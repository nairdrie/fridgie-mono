// The quantity engine now lives in packages/shared so the client and server
// cannot drift apart again. This file is a re-export shim so existing
// `@/utils/quantity` imports keep working.
//
// Note `formatQuantity` is CANONICAL (singular, "2 cup") and is what gets
// stored; use `formatQuantityDisplay` for anything rendered to the user.

export {
  aggregateQuantities,
  convert,
  formatQuantity,
  formatFriendlyValue,
  formatQuantityDisplay,
  formatValue,
  normalizeIngredients,
  normalizeQuantity,
  normalizeUnit,
  parseQuantity,
  parseQuantityAndText,
  parseValueToken,
  preNormalize,
  quantitiesEquivalent,
  singularizeUnit,
  unitCycle,
} from '@fridgie/shared/quantity';

export type { Dimension, ParsedQuantity } from '@fridgie/shared/quantity';
