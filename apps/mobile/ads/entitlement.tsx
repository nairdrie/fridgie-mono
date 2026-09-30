import type { AdEntitlementState } from '@/utils/discoverAds';
import React, { createContext, useContext, useEffect, useState } from 'react';

/**
 * Deliberately narrower than a subscription API. The Pro implementation only
 * needs to answer whether ads are allowed; it remains the owner of products,
 * receipts, trials, restoration, and account state.
 */
export interface DiscoverAdEntitlementAdapter {
  getAdEntitlement(): AdEntitlementState | Promise<AdEntitlementState>;
  subscribe?(listener: (state: AdEntitlementState) => void): () => void;
}

const unavailableAdapter: DiscoverAdEntitlementAdapter = {
  // Unknown suppresses ads. A missing or temporarily broken Pro integration
  // must never make an entitled user see one.
  getAdEntitlement: () => 'unknown',
};

type DiscoverAdEntitlementSource = DiscoverAdEntitlementAdapter | AdEntitlementState;

const DiscoverAdEntitlementContext = createContext<DiscoverAdEntitlementSource>(unavailableAdapter);

const normalizedEntitlement = (value: unknown): AdEntitlementState => (
  value === 'ad-supported' || value === 'ad-free' ? value : 'unknown'
);

export interface ProDiscoverAdState {
  isPro: boolean;
  isLoading: boolean;
  status: {
    isPro: boolean;
    entitlement: { status: 'active' | 'inactive' | 'unavailable' };
  } | null;
  statusError: string | null;
  verificationPending: boolean;
  isBillingStateLoading: boolean;
  action: 'purchasing' | 'restoring' | null;
}

/**
 * Ads are allowed only after the API has positively identified this account as
 * Free. Every ambiguous transition fails closed, while a verified Pro snapshot
 * suppresses ads immediately even if purchase recovery is still settling.
 */
export function discoverAdEntitlementFromPro(state: ProDiscoverAdState): AdEntitlementState {
  if (state.isPro && state.status?.isPro === true) return 'ad-free';
  if (
    state.isLoading
    || state.isBillingStateLoading
    || state.statusError !== null
    || state.verificationPending
    || state.action !== null
    || !state.status
    || state.isPro !== state.status.isPro
  ) return 'unknown';
  return state.status.isPro === false && state.status.entitlement.status === 'inactive'
    ? 'ad-supported'
    : 'unknown';
}

export async function readDiscoverAdEntitlement(adapter: DiscoverAdEntitlementAdapter): Promise<AdEntitlementState> {
  try {
    const value = await adapter.getAdEntitlement();
    return normalizedEntitlement(value);
  } catch {
    return 'unknown';
  }
}

export function DiscoverAdEntitlementProvider({
  adapter,
  children,
}: {
  adapter: DiscoverAdEntitlementAdapter;
  children: React.ReactNode;
}) {
  return <DiscoverAdEntitlementContext.Provider value={adapter}>{children}</DiscoverAdEntitlementContext.Provider>;
}

/** A synchronous source is used by the Pro bridge so account changes cannot
 * leave the previous Free result visible until an effect runs. */
export function DiscoverAdEntitlementStateProvider({
  state,
  children,
}: {
  state: AdEntitlementState;
  children: React.ReactNode;
}) {
  return <DiscoverAdEntitlementContext.Provider value={normalizedEntitlement(state)}>{children}</DiscoverAdEntitlementContext.Provider>;
}

export function useDiscoverAdEntitlement(): AdEntitlementState {
  const source = useContext(DiscoverAdEntitlementContext);
  const [adapterState, setAdapterState] = useState<AdEntitlementState>('unknown');

  useEffect(() => {
    if (typeof source === 'string') {
      setAdapterState('unknown');
      return;
    }
    let active = true;
    setAdapterState('unknown');
    void readDiscoverAdEntitlement(source).then(value => { if (active) setAdapterState(value); });
    const unsubscribe = source.subscribe?.(value => {
      if (active) setAdapterState(normalizedEntitlement(value));
    });
    return () => { active = false; unsubscribe?.(); };
  }, [source]);

  return typeof source === 'string' ? normalizedEntitlement(source) : adapterState;
}

export const unavailableDiscoverAdEntitlementAdapter = unavailableAdapter;
