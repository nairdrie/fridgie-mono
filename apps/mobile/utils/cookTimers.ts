// Durations mentioned in recipe steps — see packages/shared/cookTimers.ts.
//
// Shared rather than local because it is pure string logic with real edge
// cases ("cut into 2 inch pieces" must never become a timer), and the tests
// that pin those live with the rest of the shared suite.

export { findStepTimers, formatCountdown, formatDuration } from '@fridgie/shared/cookTimers';
export type { StepTimer } from '@fridgie/shared/cookTimers';
