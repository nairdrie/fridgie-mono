import { fs } from './firebase';
import {
  aiPlans,
  hourlyAiAttemptLimits,
  maxConcurrentLeftoversScans,
  type AccountPlan,
} from './aiPlans';
import {
  AiAttemptLedger,
  AiQuotaLedger,
  type AttemptRateDecision,
  type AiUsageStatus,
  type AtomicAiUsageStore,
  type QuotaReservation,
  type StoredAiUsage,
} from './aiQuotaCore';
import {
  getEntitlement,
  type PublicEntitlement,
  type ResolvedEntitlement,
} from './entitlements';

export interface AccountStatus {
  plan: AccountPlan;
  isPro: boolean;
  entitlement: PublicEntitlement;
  aiUsage: AiUsageStatus;
  /** Separate because one photo scan plus one suggestion is one user workflow. */
  leftoversScanUsage: AiUsageStatus | null;
}

export interface AccountQuotaReservation extends QuotaReservation {
  accountStatus: AccountStatus;
}

export class FirestoreAiUsageStore implements AtomicAiUsageStore {
  constructor(private readonly documentId = 'aiUsage') {}

  private ref(uid: string) {
    // One rolling document per account. A transaction resets it when the UTC
    // week changes, so quota cannot be reset by reinstalling or changing device.
    return fs.collection('users').doc(uid).collection('system').doc(this.documentId);
  }

  async read(uid: string): Promise<StoredAiUsage | null> {
    const snapshot = await this.ref(uid).get();
    return snapshot.exists ? snapshot.data() as StoredAiUsage : null;
  }

  async transact<T>(
    uid: string,
    update: (current: StoredAiUsage | null) => { next: StoredAiUsage | null; result: T },
  ): Promise<T> {
    const ref = this.ref(uid);
    return fs.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() as StoredAiUsage : null;
      const { next, result } = update(current);
      if (next) transaction.set(ref, next);
      return result;
    });
  }
}

const quotaLedger = new AiQuotaLedger(new FirestoreAiUsageStore());
const leftoversScanLedger = new AiQuotaLedger(new FirestoreAiUsageStore('leftoversScanUsage'));
const suggestionAttemptLedger = new AiAttemptLedger(new FirestoreAiUsageStore('suggestHourlyAttempts'));
const leftoversAttemptLedger = new AiAttemptLedger(new FirestoreAiUsageStore('leftoversHourlyAttempts'));

const publicEntitlement = (entitlement: ResolvedEntitlement): PublicEntitlement => ({
  status: entitlement.status,
  provider: entitlement.provider,
  expiresAt: entitlement.expiresAt,
  verifiedAt: entitlement.verifiedAt,
  productIdentifier: entitlement.productIdentifier,
});

const planFor = (entitlement: ResolvedEntitlement): AccountPlan =>
  entitlement.isPro ? 'pro' : 'free';

const accountStatus = (
  entitlement: ResolvedEntitlement,
  aiUsage: AiUsageStatus,
  leftoversScanUsage: AiUsageStatus | null = null,
): AccountStatus => ({
  plan: planFor(entitlement),
  isPro: entitlement.isPro,
  entitlement: publicEntitlement(entitlement),
  aiUsage,
  leftoversScanUsage,
});

export async function getAccountStatus(
  uid: string,
  options: { forceRefresh?: boolean } = {},
): Promise<AccountStatus> {
  const entitlement = await getEntitlement(uid, options);
  const plan = planFor(entitlement);
  const plans = aiPlans();
  const [usage, leftoversUsage] = await Promise.all([
    quotaLedger.status(uid, plans[plan].weeklyAiLimit),
    entitlement.isPro
      ? leftoversScanLedger.status(uid, plans.pro.weeklyLeftoversScanLimit)
      : Promise.resolve(null),
  ]);
  return accountStatus(entitlement, usage, leftoversUsage);
}

/**
 * Atomically claims one model request. Call this only after validation and all
 * non-AI prerequisites have succeeded, immediately before dispatching to the
 * provider. Firestore retries concurrent transactions, so at most `limit`
 * callers can receive accepted=true.
 */
export async function reserveAccountAiUse(uid: string): Promise<AccountQuotaReservation> {
  const entitlement = await getEntitlement(uid);
  const plan = planFor(entitlement);
  const reservation = await quotaLedger.reserve(uid, aiPlans()[plan].weeklyAiLimit);
  return { ...reservation, accountStatus: accountStatus(entitlement, reservation.usage) };
}

export const completeAccountAiUse = (uid: string, reservationId: string): Promise<boolean> =>
  quotaLedger.complete(uid, reservationId);

export const refundAccountAiUse = (uid: string, reservationId: string): Promise<boolean> =>
  quotaLedger.refund(uid, reservationId);

/**
 * Consume immediately before dispatching a meal-suggestion provider call.
 * Unlike the weekly customer allowance, this short-window spend guard cannot
 * be refunded after a provider failure.
 */
export const consumeMealSuggestionAttempt = (uid: string): Promise<AttemptRateDecision> =>
  suggestionAttemptLedger.consume(uid, hourlyAiAttemptLimits().mealSuggestions);

export class ProQuotaAccessError extends Error {
  constructor(readonly code: 'pro_required' | 'entitlement_unavailable') {
    super(code);
    this.name = 'ProQuotaAccessError';
  }
}

/**
 * Leftovers photo analysis has its own Pro-only fair-use bucket so one scan +
 * one suggestion does not misleadingly consume two visible meal suggestions.
 * A one-at-a-time pending cap prevents a single account from fanning out many
 * large multimodal calls; crashed markers stop blocking after a short lease.
 */
export async function reserveLeftoversScanUse(uid: string): Promise<QuotaReservation> {
  const entitlement = await getEntitlement(uid);
  if (entitlement.status === 'unavailable') throw new ProQuotaAccessError('entitlement_unavailable');
  if (!entitlement.isPro) throw new ProQuotaAccessError('pro_required');
  return leftoversScanLedger.reserve(
    uid,
    aiPlans().pro.weeklyLeftoversScanLimit,
    { maxPending: maxConcurrentLeftoversScans() },
  );
}

export const completeLeftoversScanUse = (uid: string, reservationId: string): Promise<boolean> =>
  leftoversScanLedger.complete(uid, reservationId);

export const refundLeftoversScanUse = (uid: string, reservationId: string): Promise<boolean> =>
  leftoversScanLedger.refund(uid, reservationId);

/** Consume immediately before dispatching Leftovers photos to the provider. */
export const consumeLeftoversScanAttempt = (uid: string): Promise<AttemptRateDecision> =>
  leftoversAttemptLedger.consume(uid, hourlyAiAttemptLimits().leftoversScans);
