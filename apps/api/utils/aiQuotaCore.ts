import { randomUUID } from 'node:crypto';
import { hourlyAiAttemptWindow, weeklyAiWindow, type AiUsageWindow } from './aiPlans';

export interface StoredAiUsage {
  schemaVersion: 1;
  windowId: string;
  windowStartsAt: string;
  windowEndsAt: string;
  used: number;
  reservations: Record<string, string>;
  updatedAt: string;
}

export interface AiUsageStatus {
  used: number;
  limit: number;
  remaining: number;
  windowStartsAt: string;
  windowEndsAt: string;
}

export interface QuotaReservation {
  accepted: boolean;
  reservationId: string | null;
  rejectionReason: 'weekly_limit' | 'too_many_pending' | null;
  usage: AiUsageStatus;
}

export interface QuotaReservationOptions {
  /** Optional account-level cap on simultaneously in-flight provider calls. */
  maxPending?: number;
}

export interface AttemptRateDecision {
  accepted: boolean;
  usage: AiUsageStatus;
}

// A process can die after reserving and before clearing its marker. The use
// remains counted, but it must not hold a concurrency slot for the whole week.
const RESERVATION_LEASE_MS = 10 * 60 * 1000;

export interface AtomicAiUsageStore {
  read(uid: string): Promise<StoredAiUsage | null>;
  transact<T>(
    uid: string,
    update: (current: StoredAiUsage | null) => { next: StoredAiUsage | null; result: T },
  ): Promise<T>;
}

const normalizedUsed = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

function freshUsage(window: AiUsageWindow, now: Date): StoredAiUsage {
  return {
    schemaVersion: 1,
    windowId: window.id,
    windowStartsAt: window.startsAt,
    windowEndsAt: window.endsAt,
    used: 0,
    reservations: {},
    updatedAt: now.toISOString(),
  };
}

/**
 * Treat corrupt or old-window state as empty. The backing store makes each
 * transition atomic; keeping the state machine here makes concurrency and
 * reset behavior testable without a Firebase emulator.
 */
function currentUsage(
  stored: StoredAiUsage | null,
  window: AiUsageWindow,
  now: Date,
): StoredAiUsage {
  if (!stored || stored.windowId !== window.id) return freshUsage(window, now);

  const reservations = stored.reservations && typeof stored.reservations === 'object'
    ? Object.fromEntries(
        Object.entries(stored.reservations).filter(
          ([id, reservedAt]) => {
            if (id.length === 0 || typeof reservedAt !== 'string') return false;
            const reservedMs = new Date(reservedAt).getTime();
            return Number.isFinite(reservedMs)
              && reservedMs > now.getTime() - RESERVATION_LEASE_MS
              && reservedMs <= now.getTime() + 60_000;
          },
        ),
      )
    : {};

  return {
    ...freshUsage(window, now),
    used: normalizedUsed(stored.used),
    reservations,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : now.toISOString(),
  };
}

function publicStatus(record: StoredAiUsage, limit: number): AiUsageStatus {
  const used = normalizedUsed(record.used);
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    windowStartsAt: record.windowStartsAt,
    windowEndsAt: record.windowEndsAt,
  };
}

export class AiQuotaLedger {
  constructor(
    private readonly store: AtomicAiUsageStore,
    private readonly now: () => Date = () => new Date(),
    private readonly makeReservationId: () => string = randomUUID,
  ) {}

  async status(uid: string, limit: number): Promise<AiUsageStatus> {
    const now = this.now();
    const window = weeklyAiWindow(now);
    const stored = await this.store.read(uid);
    return publicStatus(currentUsage(stored, window, now), limit);
  }

  async reserve(
    uid: string,
    limit: number,
    options: QuotaReservationOptions = {},
  ): Promise<QuotaReservation> {
    const now = this.now();
    const window = weeklyAiWindow(now);
    const reservationId = this.makeReservationId();

    return this.store.transact<QuotaReservation>(uid, (stored) => {
      const current = currentUsage(stored, window, now);
      if (current.used >= limit) {
        return {
          // A rejected request is read-only. This avoids turning repeated 429s
          // into unbounded Firestore writes while preserving the transaction's
          // concurrency-safe decision.
          next: null,
          result: {
            accepted: false,
            reservationId: null,
            rejectionReason: 'weekly_limit',
            usage: publicStatus(current, limit),
          },
        };
      }

      const maxPending = options.maxPending;
      if (maxPending !== undefined && Object.keys(current.reservations).length >= maxPending) {
        return {
          next: null,
          result: {
            accepted: false,
            reservationId: null,
            rejectionReason: 'too_many_pending',
            usage: publicStatus(current, limit),
          },
        };
      }

      const next: StoredAiUsage = {
        ...current,
        used: current.used + 1,
        reservations: { ...current.reservations, [reservationId]: now.toISOString() },
        updatedAt: now.toISOString(),
      };
      return {
        next,
        result: {
          accepted: true,
          reservationId,
          rejectionReason: null,
          usage: publicStatus(next, limit),
        },
      };
    });
  }

  async complete(uid: string, reservationId: string): Promise<boolean> {
    const now = this.now();
    const window = weeklyAiWindow(now);
    return this.store.transact(uid, (stored) => {
      const current = currentUsage(stored, window, now);
      if (!(reservationId in current.reservations)) return { next: null, result: false };
      const reservations = { ...current.reservations };
      delete reservations[reservationId];
      return {
        next: { ...current, reservations, updatedAt: now.toISOString() },
        result: true,
      };
    });
  }

  async refund(uid: string, reservationId: string): Promise<boolean> {
    const now = this.now();
    const window = weeklyAiWindow(now);
    return this.store.transact(uid, (stored) => {
      const current = currentUsage(stored, window, now);
      if (!(reservationId in current.reservations)) return { next: null, result: false };
      const reservations = { ...current.reservations };
      delete reservations[reservationId];
      const next: StoredAiUsage = {
        ...current,
        used: Math.max(0, current.used - 1),
        reservations,
        updatedAt: now.toISOString(),
      };
      return { next, result: true };
    });
  }
}

/**
 * A fixed-hour, consume-only provider-attempt ledger.
 *
 * This deliberately has no refund operation. Once the caller has permission
 * to dispatch to a paid provider, failures and unusable responses still count
 * against this short-window guard even when the user-facing weekly allowance
 * is refunded. The backing store transaction makes the cap safe under
 * concurrent requests from multiple API instances.
 */
export class AiAttemptLedger {
  constructor(
    private readonly store: AtomicAiUsageStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(uid: string, limit: number): Promise<AiUsageStatus> {
    const now = this.now();
    const window = hourlyAiAttemptWindow(now);
    const stored = await this.store.read(uid);
    return publicStatus(currentUsage(stored, window, now), limit);
  }

  async consume(uid: string, limit: number): Promise<AttemptRateDecision> {
    const now = this.now();
    const window = hourlyAiAttemptWindow(now);

    return this.store.transact<AttemptRateDecision>(uid, (stored) => {
      const current = currentUsage(stored, window, now);
      if (current.used >= limit) {
        return {
          next: null,
          result: { accepted: false, usage: publicStatus(current, limit) },
        };
      }

      const next: StoredAiUsage = {
        ...current,
        used: current.used + 1,
        // Attempt ledgers are consume-only and never need rollback markers.
        reservations: {},
        updatedAt: now.toISOString(),
      };
      return {
        next,
        result: { accepted: true, usage: publicStatus(next, limit) },
      };
    });
  }
}

/** Whole seconds until a rate window resets, suitable for Retry-After. */
export function retryAfterSeconds(usage: AiUsageStatus, at: Date = new Date()): number {
  const endsAt = Date.parse(usage.windowEndsAt);
  if (!Number.isFinite(endsAt) || !Number.isFinite(at.getTime())) return 60;
  return Math.max(1, Math.ceil((endsAt - at.getTime()) / 1_000));
}
