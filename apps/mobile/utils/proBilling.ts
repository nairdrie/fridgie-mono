/**
 * A tiny promise queue for native billing operations. RevenueCat owns one
 * process-wide customer identity, so configure/log-in and checkout must never
 * race each other even when Firebase auth changes quickly.
 */
export interface SerialTaskQueue {
  run<T>(task: () => Promise<T> | T): Promise<T>;
}

export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    run<T>(task: () => Promise<T> | T): Promise<T> {
      const result = tail.then(task, task);
      // A failed billing operation must not poison later identity repairs.
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

export interface BillingIdentitySnapshot {
  expectedUid: string;
  currentUid: string | null;
  readyUid: string | null;
  sdkUid: string | null;
}

/** Only configured store products may be surfaced or purchased. Package type
 * alone is not sufficient because a RevenueCat project can contain unrelated
 * monthly or annual subscriptions in the same offering. */
export function configuredBillingPeriod(
  productId: string,
  monthlyProductId: string,
  annualProductId: string,
): 'monthly' | 'annual' | null {
  if (productId === monthlyProductId) return 'monthly';
  if (productId === annualProductId) return 'annual';
  return null;
}

/** RevenueCat code 20 means the store transaction is awaiting external
 * approval (for example Ask to Buy), not that checkout failed. */
export function isStorePaymentPending(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 20 || code === '20';
}

export const PENDING_VERIFICATION_KINDS = [
  'purchase-verification',
  'purchase-account-changed',
  'restore-verification',
  'restore-account-changed',
  'payment-approval',
  'store-entitlement-verification',
] as const;

export type PendingVerificationKind = typeof PENDING_VERIFICATION_KINDS[number];

export interface PersistedPendingVerification {
  uid: string;
  kind: PendingVerificationKind;
}

/** Parse only app-authored recovery records and known kinds. AsyncStorage is a
 * durability mechanism, never an entitlement source. */
export function parsePersistedPendingVerification(
  raw: string | null,
): PersistedPendingVerification | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedPendingVerification>;
    return typeof value.uid === 'string'
      && value.uid.length > 0
      && value.uid.length <= 128
      && typeof value.kind === 'string'
      && PENDING_VERIFICATION_KINDS.includes(value.kind as PendingVerificationKind)
      ? { uid: value.uid, kind: value.kind as PendingVerificationKind }
      : null;
  } catch {
    return null;
  }
}

/** All four identities must agree immediately before a native store action. */
export function billingIdentityMatches(snapshot: BillingIdentitySnapshot): boolean {
  return !!snapshot.expectedUid
    && snapshot.currentUid === snapshot.expectedUid
    && snapshot.readyUid === snapshot.expectedUid
    && snapshot.sdkUid === snapshot.expectedUid;
}

/** A restore/status result may only resolve the transaction that owns it. */
export function pendingVerificationBelongsTo(
  pendingUid: string | null | undefined,
  verifiedUid: string,
): boolean {
  return !!pendingUid && pendingUid === verifiedUid;
}

/** A failed restore can add recovery context, but it must never erase the
 * stronger origin of an unresolved store transaction. */
export function pendingKindAfterRestoreFailure(
  existing: PendingVerificationKind | null | undefined,
  fallback: Extract<PendingVerificationKind, 'restore-verification' | 'restore-account-changed'>,
): PendingVerificationKind {
  return existing ?? fallback;
}

export interface PendingVerificationResolution {
  pendingUid: string | null | undefined;
  verifiedUid: string;
  isPro: boolean;
  /** True only after a restore and its server refresh both completed. */
  authoritativeRestore: boolean;
  /** Store approval can remain pending even when restore has no entitlement yet. */
  preserveOnNegativeRestore?: boolean;
}

/**
 * A normal non-Pro status can be stale while the store webhook catches up. An
 * authoritative same-account restore is the only negative result that can
 * safely release a pending-transaction lock.
 */
export function shouldClearPendingVerification({
  pendingUid,
  verifiedUid,
  isPro,
  authoritativeRestore,
  preserveOnNegativeRestore = false,
}: PendingVerificationResolution): boolean {
  return pendingVerificationBelongsTo(pendingUid, verifiedUid)
    && (isPro || (authoritativeRestore && !preserveOnNegativeRestore));
}
