import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  isBodyLimitError,
  SUGGESTION_MAX_REQUEST_BYTES,
  suggestionBodyLimit,
  suggestionRequestTooLarge,
} from '../utils/requestLimits';

function testApp() {
  return new Hono().post('/', suggestionBodyLimit, async (c) => {
    try {
      await c.req.text();
      return c.json({ ok: true });
    } catch (error) {
      if (isBodyLimitError(error)) return suggestionRequestTooLarge(c);
      throw error;
    }
  });
}

describe('meal-suggestion request body limit', () => {
  test('returns a stable 413 for a declared body over 64 KiB', async () => {
    const body = 'x'.repeat(SUGGESTION_MAX_REQUEST_BYTES + 1);
    const response = await testApp().request('/', {
      method: 'POST',
      headers: { 'content-length': String(body.length) },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'suggestion_request_too_large',
      message: 'Meal suggestion request is too large.',
    });
  });

  test('also limits streamed bodies without a Content-Length header', async () => {
    const response = await testApp().request('/', {
      method: 'POST',
      body: 'x'.repeat(SUGGESTION_MAX_REQUEST_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'suggestion_request_too_large' });
  });

  test('allows a body at the limit', async () => {
    const response = await testApp().request('/', {
      method: 'POST',
      body: 'x'.repeat(SUGGESTION_MAX_REQUEST_BYTES),
    });
    expect(response.status).toBe(200);
  });
});
