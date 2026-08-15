// Write-time rank validation/repair. The implementation now lives in
// packages/shared so the client applies the identical repair on read.
// This file is a re-export shim.

export {
  maxRank,
  nextRank,
  rankAfter,
  safeParseRank,
  sanitizeItems,
} from '@fridgie/shared/rank'

export type { RankableItem, RankField } from '@fridgie/shared/rank'
