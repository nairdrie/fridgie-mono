import { describe, expect, test } from 'bun:test';
import {
  aiPlans,
  hourlyAiAttemptLimits,
  hourlyAiAttemptWindow,
  weeklyAiWindow,
} from '../utils/aiPlans';
import {
  AiAttemptLedger,
  AiQuotaLedger,
  retryAfterSeconds,
  type AtomicAiUsageStore,
  type StoredAiUsage,
} from '../utils/aiQuotaCore';

class MemoryAtomicStore implements AtomicAiUsageStore {
  private readonly records = new Map<string, StoredAiUsage>();
  private readonly tails = new Map<string, Promise<void>>();

  async read(uid: string): Promise<StoredAiUsage | null> {
    const value = this.records.get(uid);
    return value ? structuredClone(value) : null;
  }

  async transact<T>(
    uid: string,
    update: (current: StoredAiUsage | null) => { next: StoredAiUsage | null; result: T },
  ): Promise<T> {
    const previous = this.tails.get(uid) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(uid, previous.then(() => turn));
    await previous;
    try {
      // Make races visible to the test while retaining the transaction lock.
      await Promise.resolve();
      const current = this.records.get(uid);
      const { next, result } = update(current ? structuredClone(current) : null);
      if (next) this.records.set(uid, structuredClone(next));
      return result;
    } finally {
      release();
    }
  }
}

describe('weekly AI windows and plan configuration', () => {
  test('uses a stable Monday-to-Monday UTC window', () => {
    expect(weeklyAiWindow(new Date('2026-09-28T00:00:00.000Z'))).toEqual({
      id: '2026-09-28',
      startsAt: '2026-09-28T00:00:00.000Z',
      endsAt: '2026-10-05T00:00:00.000Z',
    });
    expect(weeklyAiWindow(new Date('2026-10-04T23:59:59.999Z')).id).toBe('2026-09-28');
    expect(weeklyAiWindow(new Date('2026-10-05T00:00:00.000Z')).id).toBe('2026-10-05');
  });

  test('keeps free at no more than ten and Pro configurable above it', () => {
    expect(aiPlans({}).free.weeklyAiLimit).toBe(10);
    expect(aiPlans({}).pro).toMatchObject({ weeklyAiLimit: 100, weeklyLeftoversScanLimit: 50 });
    expect(aiPlans({
      FRIDGIE_FREE_WEEKLY_AI_LIMIT: '50',
      FRIDGIE_PRO_WEEKLY_AI_LIMIT: '250',
      FRIDGIE_PRO_WEEKLY_LEFTOVERS_SCAN_LIMIT: '75',
    })).toMatchObject({
      free: { weeklyAiLimit: 10, weeklyLeftoversScanLimit: 0 },
      pro: { weeklyAiLimit: 250, weeklyLeftoversScanLimit: 75 },
    });
  });

  test('uses separate configurable fixed-hour provider-attempt windows', () => {
    expect(hourlyAiAttemptLimits({})).toEqual({ mealSuggestions: 20, leftoversScans: 8, recipeChat: 40 });
    expect(hourlyAiAttemptLimits({
      FRIDGIE_SUGGEST_HOURLY_ATTEMPT_LIMIT: '30',
      FRIDGIE_LEFTOVERS_HOURLY_ATTEMPT_LIMIT: '12',
      FRIDGIE_RECIPE_CHAT_HOURLY_ATTEMPT_LIMIT: '60',
    })).toEqual({ mealSuggestions: 30, leftoversScans: 12, recipeChat: 60 });
    expect(hourlyAiAttemptWindow(new Date('2026-09-30T12:59:59.999Z'))).toEqual({
      id: '2026-09-30T12',
      startsAt: '2026-09-30T12:00:00.000Z',
      endsAt: '2026-09-30T13:00:00.000Z',
    });
  });
});

describe('AI quota ledger', () => {
  test('atomically accepts only the configured number under concurrency', async () => {
    const store = new MemoryAtomicStore();
    let id = 0;
    const ledger = new AiQuotaLedger(
      store,
      () => new Date('2026-09-30T12:00:00.000Z'),
      () => `request-${++id}`,
    );

    const attempts = await Promise.all(Array.from({ length: 40 }, () => ledger.reserve('user-1', 10)));
    expect(attempts.filter((attempt) => attempt.accepted)).toHaveLength(10);
    expect(attempts.filter((attempt) => !attempt.accepted)).toHaveLength(30);
    expect(await ledger.status('user-1', 10)).toMatchObject({ used: 10, remaining: 0, limit: 10 });
  });

  test('refunds a detected failure once and makes that slot available again', async () => {
    const store = new MemoryAtomicStore();
    let id = 0;
    const ledger = new AiQuotaLedger(store, () => new Date('2026-09-30T12:00:00.000Z'), () => `r-${++id}`);
    const first = await ledger.reserve('user-1', 1);

    expect(first.accepted).toBe(true);
    expect(await ledger.refund('user-1', first.reservationId!)).toBe(true);
    expect(await ledger.refund('user-1', first.reservationId!)).toBe(false);
    expect(await ledger.status('user-1', 1)).toMatchObject({ used: 0, remaining: 1 });
    expect((await ledger.reserve('user-1', 1)).accepted).toBe(true);
  });

  test('completion keeps the use counted and prevents a later refund', async () => {
    const store = new MemoryAtomicStore();
    const ledger = new AiQuotaLedger(store, () => new Date('2026-09-30T12:00:00.000Z'), () => 'request');
    const reservation = await ledger.reserve('user-1', 10);
    expect(await ledger.complete('user-1', reservation.reservationId!)).toBe(true);
    expect(await ledger.refund('user-1', reservation.reservationId!)).toBe(false);
    expect((await ledger.status('user-1', 10)).used).toBe(1);
  });

  test('resets at the next window without letting an old refund decrement the new week', async () => {
    const store = new MemoryAtomicStore();
    let now = new Date('2026-10-04T23:59:59.000Z');
    let id = 0;
    const ledger = new AiQuotaLedger(store, () => now, () => `r-${++id}`);
    const old = await ledger.reserve('user-1', 10);

    now = new Date('2026-10-05T00:00:00.000Z');
    expect(await ledger.status('user-1', 10)).toMatchObject({ used: 0, remaining: 10 });
    const current = await ledger.reserve('user-1', 10);
    expect(await ledger.refund('user-1', old.reservationId!)).toBe(false);
    expect(await ledger.complete('user-1', current.reservationId!)).toBe(true);
    expect((await ledger.status('user-1', 10)).used).toBe(1);
  });

  test('uses the same persisted count when the plan limit changes', async () => {
    const store = new MemoryAtomicStore();
    let id = 0;
    const ledger = new AiQuotaLedger(store, () => new Date('2026-09-30T12:00:00.000Z'), () => `r-${++id}`);
    await Promise.all(Array.from({ length: 10 }, () => ledger.reserve('user-1', 10)));
    expect(await ledger.status('user-1', 100)).toMatchObject({ used: 10, remaining: 90, limit: 100 });
    expect((await ledger.reserve('user-1', 100)).accepted).toBe(true);
    expect(await ledger.status('user-1', 10)).toMatchObject({ used: 11, remaining: 0, limit: 10 });
  });

  test('limits in-flight work and releases abandoned concurrency leases', async () => {
    const store = new MemoryAtomicStore();
    let now = new Date('2026-09-30T12:00:00.000Z');
    let id = 0;
    const ledger = new AiQuotaLedger(store, () => now, () => `scan-${++id}`);

    const first = await ledger.reserve('user-1', 50, { maxPending: 1 });
    const parallel = await ledger.reserve('user-1', 50, { maxPending: 1 });
    expect(first).toMatchObject({ accepted: true, rejectionReason: null });
    expect(parallel).toMatchObject({ accepted: false, rejectionReason: 'too_many_pending' });
    // A crashed worker leaves the use counted, but not a week-long lockout.
    now = new Date('2026-09-30T12:11:00.000Z');
    expect(await ledger.reserve('user-1', 50, { maxPending: 1 })).toMatchObject({
      accepted: true,
      usage: { used: 2, remaining: 48 },
    });
  });
});

describe('non-refundable AI provider-attempt ledger', () => {
  test('atomically caps dispatches and resets at the next UTC hour', async () => {
    const store = new MemoryAtomicStore();
    let now = new Date('2026-09-30T12:42:00.000Z');
    const ledger = new AiAttemptLedger(store, () => now);

    const attempts = await Promise.all(
      Array.from({ length: 40 }, () => ledger.consume('user-1', 20)),
    );
    expect(attempts.filter((attempt) => attempt.accepted)).toHaveLength(20);
    expect(attempts.filter((attempt) => !attempt.accepted)).toHaveLength(20);
    expect(await ledger.status('user-1', 20)).toMatchObject({ used: 20, remaining: 0, limit: 20 });

    now = new Date('2026-09-30T13:00:00.000Z');
    expect(await ledger.status('user-1', 20)).toMatchObject({ used: 0, remaining: 20 });
    expect((await ledger.consume('user-1', 20)).accepted).toBe(true);
  });

  test('reports whole seconds until a rejected window resets', () => {
    expect(retryAfterSeconds({
      used: 20,
      limit: 20,
      remaining: 0,
      windowStartsAt: '2026-09-30T12:00:00.000Z',
      windowEndsAt: '2026-09-30T13:00:00.000Z',
    }, new Date('2026-09-30T12:42:00.001Z'))).toBe(1_080);
  });
});
