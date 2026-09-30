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

const DiscoverAdEntitlementContext = createContext<DiscoverAdEntitlementAdapter>(unavailableAdapter);

export async function readDiscoverAdEntitlement(adapter: DiscoverAdEntitlementAdapter): Promise<AdEntitlementState> {
  try {
    const value = await adapter.getAdEntitlement();
    return value === 'ad-supported' || value === 'ad-free' ? value : 'unknown';
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

export function useDiscoverAdEntitlement(): AdEntitlementState {
  const adapter = useContext(DiscoverAdEntitlementContext);
  const [state, setState] = useState<AdEntitlementState>('unknown');

  useEffect(() => {
    let active = true;
    setState('unknown');
    void readDiscoverAdEntitlement(adapter).then(value => { if (active) setState(value); });
    const unsubscribe = adapter.subscribe?.(value => {
      if (active) setState(value === 'ad-supported' || value === 'ad-free' ? value : 'unknown');
    });
    return () => { active = false; unsubscribe?.(); };
  }, [adapter]);

  return state;
}

export const unavailableDiscoverAdEntitlementAdapter = unavailableAdapter;
