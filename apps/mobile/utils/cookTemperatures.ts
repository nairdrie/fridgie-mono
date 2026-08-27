// Oven temperatures mentioned in recipe steps — see packages/shared/cookTemperatures.ts.
//
// Shared rather than local for the same reason cookTimers is: it is pure string
// logic with real false positives to avoid ("add 350 g of flour" must never
// become a temperature), and the tests that pin those live with the shared suite.

export {
  convertTemperature,
  findStepTemperatures,
  formatTemperature,
  splitStepTemperatures,
} from '@fridgie/shared/cookTemperatures';
export type { TempScale, Temperature, TempSegment } from '@fridgie/shared/cookTemperatures';
