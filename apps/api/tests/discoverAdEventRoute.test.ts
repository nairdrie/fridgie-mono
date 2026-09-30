import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

type AggregateWrite = {
  collection: string;
  id: string;
  value: Record<string, any>;
  options: { merge?: boolean } | undefined;
};

let writes: AggregateWrite[] = [];
let failWrites = false;

const fakeFirestore = {
  collection: (collection: string) => ({
    doc: (id: string) => ({
      set: async (value: Record<string, any>, options?: { merge?: boolean }) => {
        if (failWrites) throw new Error('private provider diagnostic');
        writes.push({ collection, id, value, options });
      },
    }),
  }),
};

mock.module('../utils/firebase', () => ({
  fs: fakeFirestore,
  adminAuth: {
    verifyIdToken: async (token: string) => {
      if (token !== 'valid-token') throw new Error('invalid token');
      return { uid: 'must-not-be-stored', firebase: { sign_in_provider: 'anonymous' } };
    },
  },
}));

const eventRoute = (await import('../api/explore/ads/event')).default;
const app = new Hono().route('/api/explore/ads/event', eventRoute);
const post = (body: string, authorization = 'Bearer valid-token') => app.request('/api/explore/ads/event', {
  method: 'POST',
  headers: { authorization, 'content-type': 'application/json' },
  body,
});

beforeEach(() => {
  writes = [];
  failWrites = false;
});

describe('POST /api/explore/ads/event', () => {
  test('authenticates but stores only an atomic daily aggregate', async () => {
    const response = await post(JSON.stringify({ event: 'impression', provider: 'house' }));
    expect(response.status).toBe(204);
    expect(writes).toHaveLength(1);

    const write = writes[0]!;
    expect(write.collection).toBe('discoveryAdMetrics');
    expect(write.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(write.options).toEqual({ merge: true });
    expect(write.value.schemaVersion).toBe(1);
    expect(write.value.day).toBe(write.id);
    expect(Object.keys(write.value)).toEqual(['schemaVersion', 'day', 'counts', 'updatedAt']);
    expect(write.value.counts.house.impressions.constructor.name).toBe('NumericIncrementTransform');
    expect(write.value.counts.house.impressions.operand).toBe(1);
    expect(write.value.updatedAt.constructor.name).toBe('ServerTimestampTransform');
    expect(JSON.stringify(write.value)).not.toContain('must-not-be-stored');
  });

  test('rejects unauthenticated, malformed, contextual, and oversized bodies without a write', async () => {
    expect((await post(JSON.stringify({ event: 'click', provider: 'house' }), '')).status).toBe(401);
    expect((await post('{')).status).toBe(400);
    expect((await post(JSON.stringify({ event: 'click', provider: 'unknown' }))).status).toBe(400);
    expect((await post(JSON.stringify({ event: 'click', provider: 'admob', recipeId: 'private' }))).status).toBe(400);
    expect((await post(JSON.stringify({ event: 'click', provider: 'house', padding: 'x'.repeat(2_000) }))).status).toBe(413);
    expect(writes).toHaveLength(0);
  });

  test('uses increment transforms for concurrent aggregate updates', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () =>
      post(JSON.stringify({ event: 'hide', provider: 'admob' }))));
    expect(responses.every(response => response.status === 204)).toBe(true);
    expect(writes).toHaveLength(12);
    expect(writes.every(write =>
      write.value.counts.admob.hides.constructor.name === 'NumericIncrementTransform'
      && write.value.counts.admob.hides.operand === 1
    )).toBe(true);
  });

  test('returns a generic failure without persisting provider diagnostics', async () => {
    failWrites = true;
    const original = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const response = await post(JSON.stringify({ event: 'report', provider: 'house' }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Could not record advertising event.' });
      expect(writes).toHaveLength(0);
      expect(errors.flat().join(' ')).not.toContain('private provider diagnostic');
    } finally {
      console.error = original;
    }
  });
});
