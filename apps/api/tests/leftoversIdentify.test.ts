import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createIdentifyLeftoversHandler } from '../api/meal/leftovers/identify';
import { createRequirePro } from '../middleware/requirePro';
import type { AttemptRateDecision, QuotaReservation } from '../utils/aiQuotaCore';

const image = 'data:image/jpeg;base64,TWFu';

const usage = {
  used: 1,
  limit: 50,
  remaining: 49,
  windowStartsAt: '2026-09-28T00:00:00.000Z',
  windowEndsAt: '2026-10-05T00:00:00.000Z',
};

const acceptedReservation: QuotaReservation = {
  accepted: true,
  reservationId: 'scan-1',
  rejectionReason: null,
  usage,
};

const attemptUsage = {
  used: 1,
  limit: 8,
  remaining: 7,
  windowStartsAt: '2026-09-30T12:00:00.000Z',
  windowEndsAt: '2026-09-30T13:00:00.000Z',
};

const acceptedAttempt: AttemptRateDecision = { accepted: true, usage: attemptUsage };

function setup(options: {
  pro?: boolean;
  result?: unknown;
  reservation?: QuotaReservation;
  attempt?: AttemptRateDecision;
} = {}) {
  const model = mock(async <T>(_request: unknown): Promise<T> => (options.result ?? {
    ingredients: [
      { name: 'eggs', confidence: 'high' },
      { name: ' leafy   greens ', confidence: 'medium' },
    ],
  }) as T);
  const hasPro = mock(async () => options.pro ?? true);
  const reserveScan = mock(async () => options.reservation ?? acceptedReservation);
  const consumeAttempt = mock(async () => options.attempt ?? acceptedAttempt);
  const completeScan = mock(async () => true);
  const refundScan = mock(async () => true);
  const app = new Hono()
    .use('*', async (c, next) => { c.set('uid', 'test-user'); await next(); })
    .use('*', createRequirePro(async () => ({
      isPro: await hasPro(),
      status: (options.pro ?? true) ? 'active' : 'inactive',
      provider: 'none',
      expiresAt: null,
      verifiedAt: null,
      productIdentifier: null,
    })))
    .post('/', createIdentifyLeftoversHandler({
      completeJson: model as any,
      reserveScan,
      consumeAttempt,
      completeScan,
      refundScan,
    }));
  const request = (images: unknown = [image]) => app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images }),
  });
  return { model, hasPro, reserveScan, consumeAttempt, completeScan, refundScan, request };
}

describe('Leftovers Mode identification endpoint', () => {
  test('requires a server-verified Pro entitlement before invoking vision', async () => {
    const { request, model } = setup({ pro: false });
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'pro_required' });
    expect(model).not.toHaveBeenCalled();
  });

  test('sends every valid photo in one transient multimodal request', async () => {
    const { request, model, completeScan, refundScan } = setup();
    const response = await request([image, image]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ingredients: [
        { name: 'eggs', confidence: 'high' },
        { name: 'leafy greens', confidence: 'medium' },
      ],
      warnings: [],
      scanUsage: usage,
    });
    const call = model.mock.calls[0]![0] as any;
    expect(call.user.filter((part: any) => part.type === 'image')).toHaveLength(2);
    expect(call.maxTokens).toBe(2500);
    expect(call.timeoutMs).toBe(100_000);
    expect(call.maxRetries).toBe(0);
    expect(completeScan).toHaveBeenCalledWith('test-user', 'scan-1');
    expect(refundScan).not.toHaveBeenCalled();
  });

  test('continues with good photos and reports partial input failures', async () => {
    const { request, model } = setup();
    const response = await request(['broken', image]);
    expect(response.status).toBe(200);
    expect((await response.json()).warnings).toHaveLength(1);
    expect((model.mock.calls[0]![0] as any).user.filter((part: any) => part.type === 'image')).toHaveLength(1);
  });

  test('refunds a scan that produces no usable editable ingredients', async () => {
    const { request, completeScan, refundScan } = setup({ result: { ingredients: [] } });
    const response = await request();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'ingredients_not_found' });
    expect(refundScan).toHaveBeenCalledWith('test-user', 'scan-1');
    expect(completeScan).not.toHaveBeenCalled();
  });

  test('keeps photos available for retry when vision fails without persisting them', async () => {
    const model = mock(async () => { throw new Error('provider request failed'); });
    const refundScan = mock(async () => true);
    const app = new Hono()
      .use('*', async (c, next) => { c.set('uid', 'test-user'); await next(); })
      .post('/', createIdentifyLeftoversHandler({
        completeJson: model as any,
        reserveScan: async () => acceptedReservation,
        consumeAttempt: async () => acceptedAttempt,
        completeScan: async () => true,
        refundScan,
      }));
    const response = await app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: [image] }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'identification_failed' });
    expect(refundScan).toHaveBeenCalledWith('test-user', 'scan-1');
  });

  test('rejects weekly and concurrent scan limits before invoking vision', async () => {
    for (const [rejectionReason, error] of [
      ['weekly_limit', 'leftovers_scan_limit'],
      ['too_many_pending', 'leftovers_scan_busy'],
    ] as const) {
      const { request, model, consumeAttempt } = setup({
        reservation: {
          accepted: false,
          reservationId: null,
          rejectionReason,
          usage: { ...usage, used: 50, remaining: 0 },
        },
      });
      const response = await request();
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error });
      expect(model).not.toHaveBeenCalled();
      expect(consumeAttempt).not.toHaveBeenCalled();
    }
  });

  test('rate-limits provider attempts without spending the refundable weekly scan', async () => {
    const { request, model, refundScan, completeScan } = setup({
      attempt: {
        accepted: false,
        usage: { ...attemptUsage, used: 8, remaining: 0 },
      },
    });
    const response = await request();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await response.json()).toEqual({
      error: 'leftovers_attempt_rate_exceeded',
      message: 'Too many Leftovers Mode attempts right now. Please try again after this short cooldown.',
      attemptUsage: { ...attemptUsage, used: 8, remaining: 0 },
    });
    expect(refundScan).toHaveBeenCalledWith('test-user', 'scan-1');
    expect(model).not.toHaveBeenCalled();
    expect(completeScan).not.toHaveBeenCalled();
  });
});
