import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

export const SUGGESTION_MAX_REQUEST_BYTES = 64 * 1024;

export const suggestionRequestTooLarge = (c: Context) => c.json({
  error: 'suggestion_request_too_large',
  message: 'Meal suggestion request is too large.',
}, 413);

/**
 * Reject a declared or streaming body before the suggestion handler performs
 * account reads or reserves any paid work.
 */
export const suggestionBodyLimit = bodyLimit({
  maxSize: SUGGESTION_MAX_REQUEST_BYTES,
  onError: suggestionRequestTooLarge,
});

export const isBodyLimitError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'BodyLimitError';
