import { StripeProvider } from '@stripe/stripe-react-native';
import React from 'react';

/** Native Stripe context. The key can be supplied at build time or by checkout. */
export default function StripeAppProvider({ children }: { children: React.ReactNode }) {
  return (
    <StripeProvider
      publishableKey={process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''}
      merchantIdentifier={process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER ?? 'merchant.com.nairdrie.fridgie'}
      urlScheme="fridgie"
    >
      <>{children}</>
    </StripeProvider>
  );
}
