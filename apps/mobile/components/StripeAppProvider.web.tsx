import React from 'react';

/** Stripe's React Native SDK is native-only; web keeps the rest of Fridgie usable. */
export default function StripeAppProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
