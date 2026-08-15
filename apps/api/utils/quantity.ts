// Server-side quantity normalization. The implementation now lives in
// packages/shared alongside the client's parser, so a string this server stores
// is always one the client can parse back. This file is a re-export shim.

export {
  aggregateQuantities,
  convert,
  formatQuantity,
  formatQuantityDisplay,
  formatValue,
  normalizeIngredients,
  normalizeQuantity,
  normalizeUnit,
  parseQuantity,
  parseQuantityAndText,
  preNormalize,
  quantitiesEquivalent,
  singularizeUnit,
} from '@fridgie/shared/quantity'

export type { Dimension, ParsedQuantity } from '@fridgie/shared/quantity'
