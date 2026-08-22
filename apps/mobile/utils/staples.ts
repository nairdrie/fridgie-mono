// Staples — see packages/shared/staples.ts for what they are and why the app
// never asks the user to enter one.
//
// The client's whole job here is recognition: the server decides which keys are
// staples, and this matches the rows on screen against them using the identical
// canonicalization, so the two can never disagree about which row is which.

export {
  STAPLE_THRESHOLD,
  detectStapleRejections,
  isStapleRow,
  stapleKey,
} from '@fridgie/shared/staples';
