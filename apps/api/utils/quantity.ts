// Server-side quantity normalization. The implementation now lives in
// packages/shared alongside the client's parser, so a string this server stores
// is always one the client can parse back. This file is a re-export shim.

export {
  aggregateQuantities,
  conversionCycle,
  convert,
  displayQuantity,
  formatQuantity,
  formatQuantityDisplay,
  formatValue,
  normalizeIngredients,
  normalizeQuantity,
  nextUnitInCycle,
  normalizeUnit,
  parseQuantity,
  parseQuantityAndText,
  preNormalize,
  quantitiesEquivalent,
  singularizeUnit,
} from '@fridgie/shared/quantity'

export type { Dimension, ParsedQuantity, QuantityView } from '@fridgie/shared/quantity'
