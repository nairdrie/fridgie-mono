import { PRO_CONFIG, type ProBillingPeriod } from '@/constants/pro';
import { useAuth } from '@/context/AuthContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAccountStatus, refreshAccountStatus } from '@/utils/api';
import {
  billingIdentityMatches,
  configuredBillingPeriod,
  createSerialTaskQueue,
  isStorePaymentPending,
  parsePersistedPendingVerification,
  pendingKindAfterRestoreFailure,
  pendingVerificationBelongsTo,
  shouldClearPendingVerification,
  type PendingVerificationKind,
} from '@/utils/proBilling';
import { accountStatusForUid, type AccountStatus, type AiUsage } from '@/utils/pro';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform } from 'react-native';
import type {
  CustomerInfoUpdateListener,
  PurchasesPackage,
} from 'react-native-purchases';

export interface ProOffer {
  id: string;
  productId: string;
  period: ProBillingPeriod;
  title: string;
  price: string;
  pricePerMonth: string | null;
}

type PurchaseResult = 'purchased' | 'verification-pending' | 'cancelled' | 'failed';
type RestoreResult = 'restored' | 'verification-pending' | 'not-found' | 'failed';

interface ProContextValue {
  /** Server-verified entitlement only. Never derived from local store state. */
  isPro: boolean;
  isLoading: boolean;
  status: AccountStatus | null;
  usage: AiUsage | null;
  statusError: string | null;
  /** Purchases need a durable Firebase account, not a device-local guest uid. */
  requiresAccount: boolean;
  billingConfigured: boolean;
  isLoadingOffers: boolean;
  offers: ProOffer[];
  billingError: string | null;
  /** A store transaction completed and must be resolved before another purchase. */
  verificationPending: boolean;
  /** False only while durable purchase-recovery state is being hydrated. */
  isBillingStateLoading: boolean;
  /** Retries the fail-closed device recovery-state check. */
  retryBillingStateHydration: () => Promise<boolean>;
  /** The unresolved transaction belongs to another signed-in Firebase account. */
  verificationPendingForDifferentAccount: boolean;
  action: 'purchasing' | 'restoring' | null;
  refresh: () => Promise<AccountStatus | null>;
  /** Applies a complete status returned by a quota rejection immediately. */
  applyAccountStatus: (status: AccountStatus) => void;
  /** Applies a server-returned quota snapshot immediately, before reconciliation. */
  applyAiUsage: (usage: AiUsage) => void;
  reloadOffers: () => Promise<void>;
  purchase: (offerId: string) => Promise<PurchaseResult>;
  restore: () => Promise<RestoreResult>;
  clearBillingError: () => void;
}

const ProContext = createContext<ProContextValue | null>(null);

type PurchasesModule = typeof import('react-native-purchases');

let purchasesModulePromise: Promise<PurchasesModule> | null = null;
/** RevenueCat has one process-wide identity; every mutation/check runs here. */
const revenueCatQueue = createSerialTaskQueue();

class BillingIdentityMismatchError extends Error {
  constructor() {
    super('billing_identity_mismatch');
    this.name = 'BillingIdentityMismatchError';
  }
}

class BillingAccountChangedError extends Error {
  constructor() {
    super('billing_account_changed');
    this.name = 'BillingAccountChangedError';
  }
}

const PURCHASE_VERIFICATION_PENDING =
  'The store completed your purchase, but Fridgie could not securely verify Pro yet. '
  + 'Don’t purchase again. When you’re online, tap Restore Purchases to finish verification.';

const PURCHASE_ACCOUNT_CHANGED =
  'The store completed your purchase, but your Fridgie account changed before verification. '
  + 'Don’t purchase again. Sign back in to the account that started it, then tap Restore Purchases.';

const RESTORE_VERIFICATION_PENDING =
  'The store restore completed, but Fridgie could not securely verify Pro yet. '
  + 'Don’t purchase again. Check your connection and try Restore Purchases again.';

const RESTORE_ACCOUNT_CHANGED =
  'The store restore completed, but your Fridgie account changed before verification. '
  + 'Don’t purchase again. Sign back in to the account that started the restore and try again.';

const PAYMENT_APPROVAL_PENDING =
  'Your store purchase is awaiting approval. Don’t purchase again. After it is approved, tap Restore Purchases to finish verification.';

const PENDING_VERIFICATION_STORAGE_KEY = '@fridgie/pro-pending-verification-v1';
const pendingVerificationMessage = (kind: PendingVerificationKind): string => ({
  'purchase-verification': PURCHASE_VERIFICATION_PENDING,
  'purchase-account-changed': PURCHASE_ACCOUNT_CHANGED,
  'restore-verification': RESTORE_VERIFICATION_PENDING,
  'restore-account-changed': RESTORE_ACCOUNT_CHANGED,
  'payment-approval': PAYMENT_APPROVAL_PENDING,
  'store-entitlement-verification': PURCHASE_VERIFICATION_PENDING,
})[kind];

function revenueCatKey(): string {
  if (Platform.OS === 'ios') return PRO_CONFIG.revenueCatKeys.ios;
  if (Platform.OS === 'android') return PRO_CONFIG.revenueCatKeys.android;
  return '';
}

function loadPurchases(): Promise<PurchasesModule> {
  purchasesModulePromise ??= import('react-native-purchases');
  return purchasesModulePromise;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function wasCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const purchaseError = error as { userCancelled?: unknown; code?: unknown };
  return purchaseError.userCancelled === true || purchaseError.code === '1';
}

function periodFor(aPackage: PurchasesPackage): ProBillingPeriod | null {
  return configuredBillingPeriod(
    aPackage.product.identifier,
    PRO_CONFIG.products.monthly,
    PRO_CONFIG.products.annual,
  );
}

function normalizeOffers(packages: PurchasesPackage[]): {
  offers: ProOffer[];
  raw: Map<string, PurchasesPackage>;
} {
  const raw = new Map<string, PurchasesPackage>();
  const offers = packages.flatMap<ProOffer>(aPackage => {
    const period = periodFor(aPackage);
    if (!period) return [];
    raw.set(aPackage.identifier, aPackage);
    return [{
      id: aPackage.identifier,
      productId: aPackage.product.identifier,
      period,
      title: period === 'annual' ? 'Yearly' : 'Monthly',
      price: aPackage.product.priceString,
      pricePerMonth: aPackage.product.pricePerMonthString,
    }];
  });

  // The annual plan is the better-value hypothesis and the preferred default.
  offers.sort((a, b) => (a.period === 'annual' ? -1 : b.period === 'annual' ? 1 : 0));
  return { offers, raw };
}

export function ProProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const accountUid = user && !user.isAnonymous ? user.uid : null;
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [statusOwnerUid, setStatusOwnerUid] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusErrorOwnerUid, setStatusErrorOwnerUid] = useState<string | null>(null);
  const [offers, setOffers] = useState<ProOffer[]>([]);
  const [isLoadingOffers, setIsLoadingOffers] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [verificationPending, setVerificationPending] = useState(false);
  const [isBillingStateLoading, setIsBillingStateLoading] = useState(true);
  const [action, setAction] = useState<'purchasing' | 'restoring' | null>(null);
  const accountUidRef = useRef<string | null>(accountUid);
  const identityReadyUid = useRef<string | null>(null);
  const identityGeneration = useRef(0);
  const offersForUid = useRef<{ uid: string; raw: Map<string, PurchasesPackage> } | null>(null);
  const listenerAttached = useRef(false);
  const mounted = useRef(true);
  const actionRef = useRef<'purchasing' | 'restoring' | null>(null);
  const pendingVerificationRef = useRef<{ uid: string; kind: PendingVerificationKind } | null>(null);
  const billingStateHydratedRef = useRef(false);
  const billingHydrationVersion = useRef(0);
  const attemptedBoundaryRefresh = useRef<number | null>(null);
  const requestVersion = useRef(0);
  const statusOwnerUidRef = useRef<string | null>(null);
  accountUidRef.current = accountUid;

  const billingConfigured = !!revenueCatKey();
  const requiresAccount = accountUid === null;
  const verificationPendingForDifferentAccount = verificationPending
    && accountUid !== null
    && pendingVerificationRef.current?.uid !== accountUid;
  // Auth changes render before the cleanup effect below runs. Associate every
  // server snapshot/error with its Firebase uid so that first render can never
  // expose the previous account's plan (or briefly authorize an ad request).
  const visibleStatus = accountStatusForUid(accountUid, statusOwnerUid, status);
  const visibleStatusError = statusErrorOwnerUid === accountUid ? statusError : null;
  const visibleIsLoading = isLoading || (
    accountUid !== null
    && visibleStatus === null
    && visibleStatusError === null
  );

  const visiblePendingMessage = useCallback((): string | null => {
    const pending = pendingVerificationRef.current;
    if (!pending) return null;
    return pending.uid === accountUidRef.current
      ? pendingVerificationMessage(pending.kind)
      : PURCHASE_ACCOUNT_CHANGED;
  }, []);

  const markVerificationPending = useCallback(async (uid: string, kind: PendingVerificationKind) => {
    const pending = { uid, kind };
    pendingVerificationRef.current = pending;
    if (mounted.current) {
      setVerificationPending(true);
      setBillingError(pendingVerificationMessage(kind));
    }
    try {
      await AsyncStorage.setItem(PENDING_VERIFICATION_STORAGE_KEY, JSON.stringify(pending));
    } catch (error) {
      console.warn('Could not persist pending Fridgie Pro verification state.', error);
    }
  }, []);

  const resolvePendingVerification = useCallback(async (
    verifiedUid: string,
    isPro: boolean,
    authoritativeRestore: boolean,
  ): Promise<boolean> => {
    if (!shouldClearPendingVerification({
      pendingUid: pendingVerificationRef.current?.uid,
      verifiedUid,
      isPro,
      authoritativeRestore,
      preserveOnNegativeRestore:
        pendingVerificationRef.current?.kind === 'payment-approval'
        || pendingVerificationRef.current?.kind === 'store-entitlement-verification',
    })) return false;

    try {
      await AsyncStorage.removeItem(PENDING_VERIFICATION_STORAGE_KEY);
    } catch (error) {
      console.warn('Could not clear pending Fridgie Pro verification state.', error);
      if (mounted.current) {
        setBillingError('Pro was verified, but purchase recovery could not be finalized on this device. Try Restore Purchases again.');
      }
      return false;
    }
    pendingVerificationRef.current = null;
    if (mounted.current) setVerificationPending(false);
    return true;
  }, []);

  const fetchStatus = useCallback(async (
    force = false,
    expectedUid = accountUidRef.current,
  ): Promise<AccountStatus> => {
    if (!mounted.current || !expectedUid || accountUidRef.current !== expectedUid) {
      throw new BillingAccountChangedError();
    }
    const version = ++requestVersion.current;
    try {
      const next = force ? await refreshAccountStatus() : await getAccountStatus();
      if (!mounted.current || accountUidRef.current !== expectedUid) {
        throw new BillingAccountChangedError();
      }
      if (mounted.current && version === requestVersion.current) {
        statusOwnerUidRef.current = expectedUid;
        setStatus(next);
        setStatusOwnerUid(expectedUid);
        setStatusError(null);
        setStatusErrorOwnerUid(null);
        if (await resolvePendingVerification(expectedUid, next.isPro, false)) {
          setBillingError(null);
        }
      }
      return next;
    } catch (error) {
      if (
        mounted.current
        && accountUidRef.current === expectedUid
        && version === requestVersion.current
        && !(error instanceof BillingAccountChangedError)
      ) {
        setStatusError(errorMessage(error, 'Could not refresh your plan right now.'));
        setStatusErrorOwnerUid(expectedUid);
      }
      throw error;
    } finally {
      if (
        mounted.current
        && accountUidRef.current === expectedUid
        && version === requestVersion.current
      ) {
        setIsLoading(false);
      }
    }
  }, [resolvePendingVerification]);

  const refresh = useCallback(async (): Promise<AccountStatus | null> => {
    const uid = accountUidRef.current;
    if (!uid || actionRef.current) return null;
    try {
      return await fetchStatus(false, uid);
    } catch {
      // The visible statusError is the useful result for a pull-to-refresh or
      // foreground refresh. Callers should not need their own unhandled catch.
      return null;
    }
  }, [fetchStatus]);

  const applyAiUsage = useCallback((usage: AiUsage) => {
    const uid = accountUidRef.current;
    if (!uid || statusOwnerUidRef.current !== uid) return;
    setStatus(current => current ? { ...current, aiUsage: usage } : current);
  }, []);

  const applyAccountStatus = useCallback((next: AccountStatus) => {
    const uid = accountUidRef.current;
    if (!uid || statusOwnerUidRef.current !== uid) return;
    setStatus(current => ({
      ...next,
      // Suggest-quota responses intentionally avoid a second Firestore read
      // for the unrelated Leftovers bucket. Preserve that known Pro snapshot;
      // a genuine downgrade clears it because the incoming plan is Free.
      leftoversScanUsage: next.isPro && next.leftoversScanUsage === null
        ? current?.leftoversScanUsage ?? null
        : next.leftoversScanUsage,
    }));
    setStatusError(null);
    setStatusErrorOwnerUid(null);
  }, []);

  const customerInfoListener = useCallback<CustomerInfoUpdateListener>(() => {
    const uid = accountUidRef.current;
    if (
      !uid
      || identityReadyUid.current !== uid
      || actionRef.current !== null
      || !mounted.current
    ) return;
    void fetchStatus(true, uid).catch(() => {});
  }, [fetchStatus]);

  const identityIsCurrent = useCallback((uid: string, generation: number): boolean => (
    mounted.current
    && accountUidRef.current === uid
    && identityGeneration.current === generation
  ), []);

  /**
   * Reconcile the one native RevenueCat identity, then load offerings tagged to
   * that same Firebase UID. The global queue is important: an old async log-in
   * cannot overlap checkout or a newer account reconciliation.
   */
  const reconcileRevenueCat = useCallback(async (
    uid: string,
    generation: number,
  ): Promise<boolean> => {
    if (!billingConfigured || !identityIsCurrent(uid, generation)) return false;
    setIsLoadingOffers(true);

    try {
      const normalized = await revenueCatQueue.run(async () => {
        const { default: Purchases, LOG_LEVEL } = await loadPurchases();
        if (!identityIsCurrent(uid, generation)) return null;

        const isConfigured = await Purchases.isConfigured();
        if (!identityIsCurrent(uid, generation)) return null;

        if (!isConfigured) {
          await Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.WARN : LOG_LEVEL.ERROR);
          // There is deliberately no await between this final guard and the
          // synchronous configure call.
          if (!identityIsCurrent(uid, generation)) return null;
          Purchases.configure({ apiKey: revenueCatKey(), appUserID: uid });
        }

        let sdkUid = await Purchases.getAppUserID();
        if (!identityIsCurrent(uid, generation)) return null;
        if (sdkUid !== uid) {
          await Purchases.logIn(uid);
          // If auth changed during logIn, its queued reconciliation runs next
          // and reasserts the new UID. Never publish the old account's offers.
          if (!identityIsCurrent(uid, generation)) return null;
          sdkUid = await Purchases.getAppUserID();
        }
        if (!identityIsCurrent(uid, generation) || sdkUid !== uid) {
          identityReadyUid.current = null;
          throw new BillingIdentityMismatchError();
        }

        identityReadyUid.current = uid;
        if (!listenerAttached.current && mounted.current) {
          Purchases.addCustomerInfoUpdateListener(customerInfoListener);
          listenerAttached.current = true;
        }

        const customerInfo = await Purchases.getCustomerInfo();
        if (!identityIsCurrent(uid, generation)) return null;
        const storeHasPro = !!customerInfo.entitlements.active[PRO_CONFIG.entitlementId];

        const all = await Purchases.getOfferings();
        if (!identityIsCurrent(uid, generation)) return null;
        // Never fall back to `current`: the same RevenueCat project may host
        // unrelated products, and charging one before server verification
        // fails is not recoverable UX. Configuration must match explicitly.
        const offering = all.all[PRO_CONFIG.offeringId];
        if (!offering) {
          throw new Error('No Fridgie Pro store offering is available in this build.');
        }
        const next = normalizeOffers(offering.availablePackages);
        if (!next.offers.length) {
          throw new Error('The Fridgie Pro monthly and yearly products are not available.');
        }
        return { ...next, storeHasPro };
      });

      if (!normalized || !identityIsCurrent(uid, generation)) return false;
      offersForUid.current = { uid, raw: normalized.raw };
      setOffers(normalized.offers);
      if (normalized.storeHasPro) {
        // Local store state never unlocks Pro, but it is authoritative enough
        // to prevent a second checkout. This also closes the crash window where
        // the app is killed after the store commits but before JS can persist
        // the ordinary pending-verification record.
        // Never overwrite another account's durable recovery record (or more
        // specific Ask-to-Buy copy) while reconciling this account.
        if (!pendingVerificationRef.current) {
          await markVerificationPending(uid, 'store-entitlement-verification');
        }
        try {
          await fetchStatus(true, uid);
        } catch {
          // The durable lock and Restore path remain visible until the server
          // can verify this same account.
        }
      }
      if (actionRef.current === null && pendingVerificationRef.current === null) {
        setBillingError(null);
      }
      return true;
    } catch (error) {
      if (identityIsCurrent(uid, generation)) {
        offersForUid.current = null;
        setOffers([]);
        if (error instanceof BillingIdentityMismatchError) identityReadyUid.current = null;
        setBillingError(error instanceof BillingIdentityMismatchError
          ? 'Fridgie could not safely match the store to this account. Please reload prices and try again.'
          : errorMessage(error, 'Could not load subscription options.'));
      }
      return false;
    } finally {
      if (identityIsCurrent(uid, generation)) setIsLoadingOffers(false);
    }
  }, [billingConfigured, customerInfoListener, fetchStatus, identityIsCurrent, markVerificationPending]);

  const loadOfferings = useCallback(async () => {
    const uid = accountUidRef.current;
    if (!billingConfigured || !uid) {
      identityReadyUid.current = null;
      offersForUid.current = null;
      setOffers([]);
      setIsLoadingOffers(false);
      return;
    }

    const generation = ++identityGeneration.current;
    identityReadyUid.current = null;
    offersForUid.current = null;
    setOffers([]);
    const loaded = await reconcileRevenueCat(uid, generation);
    if (
      loaded
      && identityIsCurrent(uid, generation)
      && actionRef.current === null
      && pendingVerificationRef.current === null
    ) {
      setBillingError(null);
    }
  }, [billingConfigured, identityIsCurrent, reconcileRevenueCat]);

  const hydrateBillingState = useCallback(async (): Promise<boolean> => {
    const version = ++billingHydrationVersion.current;
    billingStateHydratedRef.current = false;
    if (mounted.current) setIsBillingStateLoading(true);

    let pending: { uid: string; kind: PendingVerificationKind } | null = null;
    try {
      const raw = await AsyncStorage.getItem(PENDING_VERIFICATION_STORAGE_KEY);
      pending = parsePersistedPendingVerification(raw);
      // A corrupt record is not usable, but checkout must remain closed unless
      // we can successfully remove it and prove the recovery store is writable.
      if (raw && !pending) await AsyncStorage.removeItem(PENDING_VERIFICATION_STORAGE_KEY);
    } catch (error) {
      console.warn('Could not hydrate pending Fridgie Pro verification state.', error);
      if (mounted.current && version === billingHydrationVersion.current) {
        setBillingError(
          'Fridgie could not safely check this device for an earlier store purchase. '
          + 'Checkout remains disabled until the check succeeds.',
        );
        setIsBillingStateLoading(true);
      }
      return false;
    }

    if (!mounted.current || version !== billingHydrationVersion.current) return false;
    if (!pendingVerificationRef.current && pending) pendingVerificationRef.current = pending;
    const currentPending = pendingVerificationRef.current;
    setVerificationPending(currentPending !== null);
    setBillingError(currentPending
      ? (currentPending.uid === accountUidRef.current
          ? pendingVerificationMessage(currentPending.kind)
          : PURCHASE_ACCOUNT_CHANGED)
      : null);
    billingStateHydratedRef.current = true;
    setIsBillingStateLoading(false);
    return true;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      identityGeneration.current += 1;
      requestVersion.current += 1;
      const shouldRemoveListener = listenerAttached.current;
      listenerAttached.current = false;
      if (shouldRemoveListener) {
        void revenueCatQueue.run(async () => {
          const { default: Purchases } = await loadPurchases();
          Purchases.removeCustomerInfoUpdateListener(customerInfoListener);
        }).catch(() => {});
      }
    };
  }, [customerInfoListener]);

  useEffect(() => {
    void hydrateBillingState();
  }, [hydrateBillingState]);

  useEffect(() => {
    if (isBillingStateLoading) return;
    const generation = ++identityGeneration.current;
    requestVersion.current += 1;
    identityReadyUid.current = null;
    offersForUid.current = null;
    setOffers([]);
    setIsLoadingOffers(false);
    statusOwnerUidRef.current = null;
    setStatus(null);
    setStatusOwnerUid(null);
    setStatusError(null);
    setStatusErrorOwnerUid(null);
    setBillingError(visiblePendingMessage());

    if (!accountUid) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    void fetchStatus(false, accountUid).catch(() => {});
    if (billingConfigured) void reconcileRevenueCat(accountUid, generation);
  }, [accountUid, billingConfigured, fetchStatus, isBillingStateLoading, reconcileRevenueCat, visiblePendingMessage]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      if (!billingStateHydratedRef.current) {
        void hydrateBillingState();
        return;
      }
      if (accountUid) void refresh();
    });
    return () => subscription.remove();
  }, [accountUid, hydrateBillingState, refresh]);

  // A foregrounded app can remain open across Monday's UTC reset without an
  // AppState transition. Refresh at the earliest server-owned boundary so the
  // profile, paywall, Suggest Meals and Leftovers all stop showing last week's
  // count at the same moment.
  useEffect(() => {
    if (!accountUid || !visibleStatus) return;
    const now = Date.now();
    const boundaries = [visibleStatus.aiUsage.windowEndsAt, visibleStatus.leftoversScanUsage?.windowEndsAt]
      .map(value => value ? Date.parse(value) : NaN)
      .filter(value => Number.isFinite(value));
    if (!boundaries.length) return;
    const earliest = Math.min(...boundaries);
    if (earliest <= now) {
      // One immediate reconciliation per boundary handles an app opened just
      // after reset. Remember the boundary so device/server clock skew cannot
      // turn a same-window response into a zero-delay request loop.
      if (attemptedBoundaryRefresh.current === earliest) return;
      attemptedBoundaryRefresh.current = earliest;
      void refresh();
      return;
    }
    const timer = setTimeout(() => {
      attemptedBoundaryRefresh.current = earliest;
      void refresh();
    }, Math.min(earliest - now + 250, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [accountUid, refresh, visibleStatus]);

  const purchase = useCallback(async (offerId: string): Promise<PurchaseResult> => {
    const purchaseUid = accountUidRef.current;
    if (!billingStateHydratedRef.current) {
      setBillingError('Checking for an earlier store purchase. Please wait a moment.');
      return 'failed';
    }
    if (pendingVerificationRef.current) {
      setBillingError(visiblePendingMessage());
      return 'verification-pending';
    }
    if (!purchaseUid) {
      setBillingError('Sign in before starting Fridgie Pro so your purchase follows you across devices.');
      return 'failed';
    }
    if (actionRef.current) return 'failed';
    const taggedOffers = offersForUid.current;
    if (
      !billingConfigured
      || taggedOffers?.uid !== purchaseUid
      || !taggedOffers.raw.has(offerId)
    ) {
      setBillingError('That subscription option is not available right now.');
      return 'failed';
    }

    actionRef.current = 'purchasing';
    setAction('purchasing');
    setBillingError(null);
    try {
      try {
        await revenueCatQueue.run(async () => {
          const { default: Purchases } = await loadPurchases();
          const currentOffers = offersForUid.current;
          const selected = currentOffers?.uid === purchaseUid
            ? currentOffers.raw.get(offerId)
            : undefined;
          const isConfigured = await Purchases.isConfigured();
          const sdkUid = isConfigured ? await Purchases.getAppUserID() : null;
          if (
            !selected
            || !billingIdentityMatches({
              expectedUid: purchaseUid,
              currentUid: accountUidRef.current,
              readyUid: identityReadyUid.current,
              sdkUid,
            })
          ) {
            throw new BillingIdentityMismatchError();
          }
          // No await belongs between the identity guard and starting checkout.
          await Purchases.purchasePackage(selected);
        });
      } catch (error) {
        if (wasCancelled(error)) return 'cancelled';
        if (isStorePaymentPending(error)) {
          await markVerificationPending(purchaseUid, 'payment-approval');
          return 'verification-pending';
        }
        if (error instanceof BillingIdentityMismatchError) {
          setBillingError('Your Fridgie account changed while checkout was preparing. No purchase was started. Please reload prices and try again.');
          void loadOfferings();
          return 'failed';
        }
        setBillingError(errorMessage(error, 'The purchase could not be completed.'));
        return 'failed';
      }

      // Persist the lock before any network verification. If the process is
      // killed in this gap, the next launch must restore rather than offering
      // another checkout for an unresolved store transaction.
      await markVerificationPending(purchaseUid, 'purchase-verification');

      if (!mounted.current || accountUidRef.current !== purchaseUid) {
        await markVerificationPending(purchaseUid, 'purchase-account-changed');
        return 'verification-pending';
      }

      let verified: AccountStatus;
      try {
        verified = await fetchStatus(true, purchaseUid);
      } catch {
        const kind: PendingVerificationKind = accountUidRef.current === purchaseUid
          ? 'purchase-verification'
          : 'purchase-account-changed';
        await markVerificationPending(purchaseUid, kind);
        return 'verification-pending';
      }
      if (!verified.isPro) {
        await markVerificationPending(purchaseUid, 'purchase-verification');
        return 'verification-pending';
      }
      await resolvePendingVerification(purchaseUid, true, false);
      if (pendingVerificationRef.current) return 'verification-pending';
      setBillingError(null);
      return 'purchased';
    } finally {
      actionRef.current = null;
      if (mounted.current) setAction(null);
    }
  }, [
    billingConfigured,
    fetchStatus,
    loadOfferings,
    markVerificationPending,
    resolvePendingVerification,
    visiblePendingMessage,
  ]);

  const restore = useCallback(async (): Promise<RestoreResult> => {
    const restoreUid = accountUidRef.current;
    if (!billingStateHydratedRef.current) {
      setBillingError('Checking for an earlier store purchase. Please wait a moment.');
      return 'failed';
    }
    if (!restoreUid) {
      setBillingError('Sign in before restoring Fridgie Pro.');
      return 'failed';
    }
    if (!billingConfigured) {
      setBillingError('Purchases are not configured in this build.');
      return 'failed';
    }
    if (actionRef.current) return 'failed';
    if (
      pendingVerificationRef.current
      && !pendingVerificationBelongsTo(pendingVerificationRef.current.uid, restoreUid)
    ) {
      setBillingError(PURCHASE_ACCOUNT_CHANGED);
      return 'verification-pending';
    }

    actionRef.current = 'restoring';
    setAction('restoring');
    if (!pendingVerificationRef.current) setBillingError(null);
    try {
      let nativeRestoreHasPro = false;
      try {
        nativeRestoreHasPro = await revenueCatQueue.run(async () => {
          const { default: Purchases } = await loadPurchases();
          const isConfigured = await Purchases.isConfigured();
          const sdkUid = isConfigured ? await Purchases.getAppUserID() : null;
          if (!billingIdentityMatches({
            expectedUid: restoreUid,
            currentUid: accountUidRef.current,
            readyUid: identityReadyUid.current,
            sdkUid,
          })) {
            throw new BillingIdentityMismatchError();
          }
          const customerInfo = await Purchases.restorePurchases();
          return !!customerInfo.entitlements.active[PRO_CONFIG.entitlementId];
        });
      } catch (error) {
        if (error instanceof BillingIdentityMismatchError) {
          setBillingError('Your Fridgie account changed while restore was preparing. No store action was started. Please reload prices and try again.');
          void loadOfferings();
          return 'failed';
        }
        setBillingError(errorMessage(error, 'Purchases could not be restored.'));
        return 'failed';
      }

      if (
        nativeRestoreHasPro
        && pendingVerificationRef.current?.kind !== 'payment-approval'
      ) {
        // Native store state cannot unlock Pro, but an active entitlement makes
        // a negative server response unsafe as proof that checkout may reopen.
        // Keep a durable lock until the server verifies the same account.
        await markVerificationPending(restoreUid, 'store-entitlement-verification');
      }

      if (!mounted.current || accountUidRef.current !== restoreUid) {
        // A restore attempt must never weaken an earlier purchase-origin lock
        // (Ask to Buy or native-active crash recovery). Keep its typed origin.
        await markVerificationPending(restoreUid, pendingKindAfterRestoreFailure(
          pendingVerificationRef.current?.kind,
          'restore-account-changed',
        ));
        return 'verification-pending';
      }

      let verified: AccountStatus;
      try {
        verified = await fetchStatus(true, restoreUid);
      } catch {
        const fallback: Extract<PendingVerificationKind, 'restore-verification' | 'restore-account-changed'> =
          accountUidRef.current === restoreUid
            ? 'restore-verification'
            : 'restore-account-changed';
        await markVerificationPending(restoreUid, pendingKindAfterRestoreFailure(
          pendingVerificationRef.current?.kind,
          fallback,
        ));
        return 'verification-pending';
      }
      if (!verified.isPro) {
        await resolvePendingVerification(restoreUid, false, true);
        if (pendingVerificationRef.current) return 'verification-pending';
        setBillingError('No active Fridgie Pro purchase was found for this store account.');
        return 'not-found';
      }
      await resolvePendingVerification(restoreUid, true, true);
      if (pendingVerificationRef.current) return 'verification-pending';
      setBillingError(null);
      return 'restored';
    } finally {
      actionRef.current = null;
      if (mounted.current) setAction(null);
    }
  }, [
    billingConfigured,
    fetchStatus,
    loadOfferings,
    markVerificationPending,
    resolvePendingVerification,
  ]);

  const value = useMemo<ProContextValue>(() => ({
    isPro: visibleStatus?.isPro === true,
    isLoading: visibleIsLoading,
    status: visibleStatus,
    usage: visibleStatus?.aiUsage ?? null,
    statusError: visibleStatusError,
    requiresAccount,
    billingConfigured,
    isLoadingOffers,
    offers,
    billingError,
    verificationPending,
    isBillingStateLoading,
    retryBillingStateHydration: hydrateBillingState,
    verificationPendingForDifferentAccount,
    action,
    refresh,
    applyAccountStatus,
    applyAiUsage,
    reloadOffers: loadOfferings,
    purchase,
    restore,
    clearBillingError: () => {
      setBillingError(visiblePendingMessage());
    },
  }), [
    action,
    applyAccountStatus,
    applyAiUsage,
    billingConfigured,
    billingError,
    isLoadingOffers,
    isBillingStateLoading,
    hydrateBillingState,
    offers,
    purchase,
    requiresAccount,
    refresh,
    restore,
    loadOfferings,
    visibleIsLoading,
    visibleStatus,
    visibleStatusError,
    verificationPending,
    verificationPendingForDifferentAccount,
    visiblePendingMessage,
  ]);

  return <ProContext.Provider value={value}>{children}</ProContext.Provider>;
}

export function usePro(): ProContextValue {
  const value = useContext(ProContext);
  if (!value) throw new Error('usePro must be used inside ProProvider');
  return value;
}
